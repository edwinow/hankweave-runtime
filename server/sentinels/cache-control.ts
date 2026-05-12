/**
 * Send-time message conversion for Anthropic prompt-caching breakpoints.
 *
 * Storage stays as `content: string` in HistoryManager. The transform here runs
 * only at send time, on a clone of the messages array — input is never mutated.
 *
 * Why TWO things have to happen for Anthropic prefix caching to actually engage
 * cache READS across fires (verified empirically against live API on 2026-05-02):
 *
 *   1. ALL retained messages must be sent in parts-form (array of content
 *      blocks), not as a bare string. Mixing string-form and parts-form for
 *      the same text content produces different JSON shapes in the Anthropic
 *      API request body, which breaks Anthropic's byte-exact prefix matching.
 *      (The cacheControl annotation itself is NOT part of the cache key — the
 *      content-block JSON shape is.)
 *
 *   2. The marker must be placed somewhere Anthropic's prefix-checking can
 *      find a previously-cached prefix to extend. The "lastMessage" policy
 *      below puts the marker on the LAST historical user/assistant message
 *      before the live current user is pushed — Anthropic's auto-prefix
 *      checking (the docs describe a roughly 20-content-block lookback from
 *      any explicit marker; we did not measure the exact bound ourselves)
 *      reliably finds the prior fire's cache and extends the cached prefix
 *      forward.
 *
 * Empirical comparison at production scale (M=70, S=20, 100 fires, T=1000):
 *   marker on FIRST historical (anchored): $1.330  (88/100 fires hit cache)
 *   marker on shift-boundary middle:       $0.820  (94/100)
 *   marker on LAST historical (lastMessage): $0.553  (97/100)  ← chosen
 *   no marker at all (parts-form only):    cache_read = 0 across all fires
 *
 * The marker is required (Anthropic does NOT auto-cache without an explicit
 * hint) and "marker on last historical" wins by a wide margin because it lets
 * Anthropic's auto-extension do the heavy lifting.
 *
 * Edge case: if the target message's content is a parts array containing only
 * non-text parts (e.g. image/file only), the helper silently no-ops on that
 * message because Anthropic carries cache markers on text parts. In practice
 * sentinels render text-form events into the prompt, so this is a marginal
 * theoretical case rather than a workflow we expect to hit.
 */

import type {
  HankweaveAssistantModelMessage,
  HankweaveModelMessage,
  HankweaveUserModelMessage,
  ProviderOptionsValue,
} from "../types/input-ai-types.js";

export interface AnthropicCacheControlOptions {
  breakpoint: "lastMessage";
  providerOptions: {
    anthropic: {
      cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" };
    };
  };
}

type CacheControl = AnthropicCacheControlOptions["providerOptions"]["anthropic"]["cacheControl"];

interface TextPartWithProviderOptions {
  type: "text";
  text: string;
  providerOptions?: ProviderOptionsValue;
}

function isTextPart(p: { type: string }): p is TextPartWithProviderOptions {
  return p.type === "text";
}

function addAnthropicCacheControl(
  part: TextPartWithProviderOptions,
  cacheControl: CacheControl,
): TextPartWithProviderOptions {
  return {
    ...part,
    providerOptions: {
      ...(part.providerOptions ?? {}),
      anthropic: {
        ...(part.providerOptions?.anthropic ?? {}),
        cacheControl,
      },
    },
  };
}

/**
 * Returns a new messages array where:
 *
 *   - EVERY user/assistant message is converted to parts-form (so the JSON
 *     shape is byte-stable across fires — required for Anthropic's prefix
 *     match to succeed; mixing string-form and parts-form across fires
 *     defeats cache reads).
 *
 *   - The LAST user/assistant message gets the Anthropic `cacheControl`
 *     marker attached to its (last) text part. The marker advances each fire
 *     as new messages are appended, but Anthropic's auto-prefix checking
 *     ~20 blocks back from the marker reliably finds the prior fire's cache
 *     and extends it forward.
 *
 * The caller is expected to apply this helper BEFORE pushing the live
 * current user message — so the "last user/assistant message" is the most
 * recent stable historical message, not the live current one.
 *
 * - Does NOT mutate the input array or any of its messages.
 * - If the input is empty, returns a shallow clone unchanged.
 * - System and tool messages are passed through unchanged (Anthropic does not
 *   honour cacheControl on those role kinds via this code path).
 */
export function applyAnthropicCacheControlBreakpoint(
  messages: HankweaveModelMessage[],
  options: AnthropicCacheControlOptions,
): HankweaveModelMessage[] {
  if (messages.length === 0) {
    return messages.slice();
  }

  const cacheControl = options.providerOptions.anthropic.cacheControl;

  // Find the LAST user/assistant message — this becomes the marker target.
  // Walk from the end so any trailing tool/system messages are skipped
  // (Anthropic carries cache markers on user/assistant content blocks).
  let markerIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role === "user" || role === "assistant") {
      markerIndex = i;
      break;
    }
  }

  if (markerIndex === -1) {
    return messages.slice();
  }

  // Convert every user/assistant message to parts-form. Only the marker
  // target carries the cacheControl annotation.
  return messages.map((msg, i) => {
    if (msg.role === "user") {
      return convertUserMessage(msg, i === markerIndex ? cacheControl : null);
    }
    if (msg.role === "assistant") {
      return convertAssistantMessage(msg, i === markerIndex ? cacheControl : null);
    }
    return msg;
  });
}

function convertUserMessage(
  message: HankweaveUserModelMessage,
  cacheControl: CacheControl | null,
): HankweaveUserModelMessage {
  if (typeof message.content === "string") {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: message.content,
          ...(cacheControl ? { providerOptions: { anthropic: { cacheControl } } } : {}),
        },
      ],
    };
  }

  // content is already an array of parts — clone parts, attach cacheControl
  // (if non-null) to the LAST text part. If no text part exists, no-op:
  // Anthropic only honours cacheControl on text content.
  const parts = message.content.map((part) => ({
    ...part,
  })) as HankweaveUserModelMessage["content"];
  if (cacheControl && Array.isArray(parts)) {
    const lastTextIndex = findLastTextIndex(parts);
    if (lastTextIndex >= 0 && isTextPart(parts[lastTextIndex])) {
      parts[lastTextIndex] = addAnthropicCacheControl(
        parts[lastTextIndex],
        cacheControl,
      ) as (typeof parts)[number];
    }
  }
  return { role: "user", content: parts };
}

function convertAssistantMessage(
  message: HankweaveAssistantModelMessage,
  cacheControl: CacheControl | null,
): HankweaveAssistantModelMessage {
  if (typeof message.content === "string") {
    return {
      role: "assistant",
      content: [
        {
          type: "text",
          text: message.content,
          ...(cacheControl ? { providerOptions: { anthropic: { cacheControl } } } : {}),
        },
      ],
    };
  }

  const parts = message.content.map((part) => ({
    ...part,
  })) as HankweaveAssistantModelMessage["content"];
  if (cacheControl && Array.isArray(parts)) {
    const lastTextIndex = findLastTextIndex(parts);
    if (lastTextIndex >= 0 && isTextPart(parts[lastTextIndex])) {
      parts[lastTextIndex] = addAnthropicCacheControl(
        parts[lastTextIndex],
        cacheControl,
      ) as (typeof parts)[number];
    }
  }
  return { role: "assistant", content: parts };
}

function findLastTextIndex(parts: ReadonlyArray<{ type: string }>): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === "text") return i;
  }
  return -1;
}
