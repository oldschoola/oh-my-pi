# Changelog

## [Unreleased]

## [15.7.3] - 2026-05-31
### Added

- Added `getFastembedCacheDir` to return the FastEmbed model cache directory under ~/.omp/cache/fastembed

### Fixed

- Fixed `$flag` environment parsing to accept lowercase truthy values such as `y`, `true`, `yes`, and `on`

## [15.6.0] - 2026-05-30

### Added

- Added an XDG-aware tiny-title model cache directory helper for coding-agent local title models.
### Added

- Added `description` and `default` fields to `CommandEntry` in `@oh-my-pi/pi-utils/cli`. When `description` is set, the root-help renderer skips importing the command module to read it — the dominant cost of `--help` cold start for any consumer that lazily loads commands. Exactly one entry should be marked `default: true`; its module is always imported so the renderer can inline its flags/args/examples.

### Changed

- Restructured `run()`'s per-subcommand help path to load ONLY the targeted subcommand instead of calling `loadAllCommands` and discarding the rest. Combined with the new metadata-only stub path, this turns `<bin> <subcommand> --help` into a one-module-load operation regardless of registry size.