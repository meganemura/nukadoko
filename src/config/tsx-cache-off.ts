// Responsibility: turn tsx's disk cache off for this process and every
// process it starts, before any module of tsx initializes. Boundary: this
// module only sets one environment variable; it imports nothing and exports
// nothing.
//
// Why: tsx keeps its transform cache in one directory under the OS temp
// directory and, when its main module initializes, reads that directory's
// whole index. The index is shared by every tsx user on the machine and only
// grows; on a machine whose index held about 261k entries, the read cost
// about 400 ms of each `nuka check` and `nuka run`. nukadoko transforms a
// handful of small files per command (the config and the step files), so a
// fresh transform costs less than the index read.
//
// Why an import and not a line in the caller: tsx reads TSX_DISABLE_CACHE
// once, when its module evaluates, and ES modules evaluate in the order the
// importing file lists them. So every file that imports `tsx/esm/api` lists
// this module first, above that import. A statement in the importing file's
// body would run after tsx had already read the variable.
//
// `??=` keeps a value the user set. Note that tsx tests the variable for
// truthiness, so "0" also turns its cache off; an empty value
// (`TSX_DISABLE_CACHE=`) is the one that keeps tsx's cache on.
//
// Child processes (`nuka run --concurrency` workers, the `nuka session`
// daemon) are spawned with the parent's environment, so they inherit the
// value set here before tsx's loader starts in them.
process.env.TSX_DISABLE_CACHE ??= "1";
