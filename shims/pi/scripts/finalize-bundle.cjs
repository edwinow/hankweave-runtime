#!/usr/bin/env node
const fs = require("fs");

const distPath = "dist/index.js";
const dropInPath = "index.js";

function normalizeGeneratedWhitespace(content) {
  let out = content.replace(/^#!.*\n/, "");

  // Bun emits source section comments using the physical dependency path. Make
  // them stable whether shims/pi/node_modules is a real install or a local
  // symlink into another checkout.
  out = out.replace(/^\/\/ .*?shims\/pi\/node_modules\//gm, "// node_modules/");
  out = out.replace(
    /var __dirname = ".*?shims\/pi\/node_modules\/([^"]+)";/g,
    'var __dirname = "node_modules/$1";',
  );

  // Bun's bundle can preserve semantically significant spaces at the end of
  // template-literal lines. Encode those spaces explicitly so `git diff --check`
  // stays green without changing runtime string values.
  out = out.replace(/` \n\\r\t`/g, "`\\x20\n\\r\t`");
  out = out.replaceAll(
    "current environment. \n` + `To learn more about authentication and Google APIs, visit: \n",
    "current environment.\\x20\n` + `To learn more about authentication and Google APIs, visit:\\x20\n",
  );
  out = out.replaceAll(
    "credentials in current environment. \n` + `To learn more about authentication and Google APIs, visit: \n",
    "credentials in current environment.\\x20\n` + `To learn more about authentication and Google APIs, visit:\\x20\n",
  );
  out = out.replaceAll(
    "Universe Domain retrieval, visit: \n",
    "Universe Domain retrieval, visit:\\x20\n",
  );
  out = out.replaceAll(
    '${a3}: ${c3} \n ${`${e4}:${i4}:${n3}`}',
    '${a3}: ${c3}\\x20\n ${`${e4}:${i4}:${n3}`}',
  );

  // These are indentation-only blank lines inside generated source strings.
  out = out.replace(
    /\n {8}\n        if \(\$\{id\}\.value === undefined\)/g,
    "\n\n        if (${id}.value === undefined)",
  );
  out = out.replace(/\n {8}\n      `\);/g, "\n\n      `);");

  out = `#!/usr/bin/env node\n${out}`;

  const offenders = out
    .split("\n")
    .flatMap((line, index) => (/[ \t]$/.test(line) ? [index + 1] : []));
  if (offenders.length > 0) {
    throw new Error(`Generated bundle still has trailing whitespace on lines: ${offenders.join(", ")}`);
  }

  return out;
}

const content = fs.readFileSync(distPath, "utf8");
const normalized = normalizeGeneratedWhitespace(content);
fs.writeFileSync(distPath, normalized);
fs.chmodSync(distPath, 0o755);
fs.copyFileSync(distPath, dropInPath);
fs.chmodSync(dropInPath, 0o755);
