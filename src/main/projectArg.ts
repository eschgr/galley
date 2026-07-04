/** Parse the per-window project name from argv (injected as `--galley-project=<name>`
 *  via webPreferences.additionalArguments). Returns the name, or null when the token
 *  is absent or carries an empty value (projectless). Everything after the first `=`
 *  is the name, so names may contain `=`. */
export function parseProjectArg(argv: readonly string[]): string | null {
  const PROJECT_ARG_PREFIX = '--galley-project=';
  const arg = argv.find((a) => a.startsWith(PROJECT_ARG_PREFIX));
  if (arg === undefined) return null;
  const name = arg.slice(PROJECT_ARG_PREFIX.length);
  return name === '' ? null : name;
}
