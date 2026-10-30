/** argv that re-runs this warden: the compiled binary itself, or `bun <cli.ts>` from source. */
export function selfCommand(main: string = Bun.main, execPath: string = process.execPath): string[] {
	return compiledSelf(main) ? [execPath] : [execPath, main];
}

/** A Bun-compiled binary runs its entry from the embedded `/$bunfs/` filesystem (`B:/~BUN/` on Windows). */
function compiledSelf(main: string): boolean {
	return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
}

/**
 * The argv prefix that runs a hidden warden subcommand in a compiled binary (`[<warden>, "__scheduler"]`), and
 * `undefined` from source, where the caller keeps running the script (`bun scheduler.main.ts`), which needs no
 * second CLI start-up.
 */
export function compiledSubcommand(
	name: string,
	main: string = Bun.main,
	execPath: string = process.execPath
): string[] | undefined {
	return compiledSelf(main) ? [execPath, name] : undefined;
}
