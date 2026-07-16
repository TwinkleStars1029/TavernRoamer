import fs from 'node:fs';

const packagePath = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const [major, minor, patch] = packageJson.version.split('.').map(Number);

packageJson.version = [major, minor, patch + 1].join('.');
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Bumped version to ${packageJson.version}`);
