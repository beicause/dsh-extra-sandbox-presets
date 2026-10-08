# dsh-extra-sandbox-presets

English | [简体中文](README.zh-CN.md)

Registers **any number of configured permission presets** in DeepSeek Harness.
Each preset selects a sandbox mode and an approval policy, plus the directories
that become writable on top of whatever that mode already allows.

That covers both directions the harness can express — a `workspace-write` preset
that opens directories beside the session workspace, and a `read-only` preset
that opens exactly the directories it lists and nothing else — and any number of
each.

The three stock sandbox modes are not modified in any way: `read-only`,
`workspace-write`, and `danger-full-access` keep their exact meaning, their
persisted schemas, and their escalation ladder.

## What it adds

One entry in the permission picker per configured preset. A typical table:

| Preset | Sandbox mode | Approval | Writes |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `ask` | nothing |
| `workspace-write` | `workspace-write` | `ask` | workspace + temp areas |
| `workspace-write-extra` | `workspace-write` | `ask` | the above **+ its configured directories** |
| `scratch` | `read-only` | `never` | **only its configured directories** |
| `danger-full-access` | `danger-full-access` | `never` | everything |

A preset is a *permission preset*, not a fourth `SandboxMode`. That distinction
is the whole point: the sandbox mode vocabulary is a closed three-value union
that is written into `sandbox/mode` session events and re-validated by several
foreign projections when a session is restored. A fourth value there would make
every session that used it unreadable. Bundling an existing mode with extra
behaviour is the same approach the shipped `auto` preset takes.

Enablement is per session: a preset's directories apply while that session's last
recorded permission preset is that preset, which survives a restart because the
choice lives in the session log.

## How it stays out of the way

The plugin does not disable, replace, or reorder any stock row. It wraps the two
live enforcement services **in place**, and unwraps them exactly on unload:

* the mounted filesystem's containment check (`checkedTarget`) gains a retry of
  its denial against the directories the selected preset grants;
* the sandbox provider's `confine` gains the matching `--bind` pairs in the
  bwrap profile.

The fence retry deliberately covers `read-only` as well: the stock fence refuses
a read-only mutation before it ever resolves the target, so the wrapper resolves
the target itself and compares it against the preset's directories. That is what
lets a `read-only` preset grant writes, and it grants exactly the directories it
lists.

The model-facing note needs the same correction, because the stock
`sandbox:policy` note is rendered from the mode alone: under `read-only` it
states that nothing may be modified, and under `workspace-write` it names only
the workspace, while a selected preset may in fact make further directories
writable. The plugin therefore listens on the `system-prompt/assemble`
waterfall and appends the granted directories to that note **in place**. In both
confined modes the note reads as a closed boundary, so the appended sentence
states the exception outright instead of relying on "additionally" alone to be
read as an override of the sentence before it: under `read-only` it says the
directories are writable *even under the read-only policy above* (the stock
sentence reads as a flat prohibition), and under `workspace-write` it says they
are writable *whether or not they are inside the session workspace* (the stock
sentence names only that path and reads as the whole writable area). A
`danger-full-access` preset leaves the note untouched: that mode already
restricts nothing, so "additionally writable directories" would be a false
statement rather than a correction. A
second context of its own would have been simpler, but it would sit next to a
stock sentence it contradicts; a context registered under the same name is not
an option either, since the system-prompt service keys contexts by name within
one layer and rejects a duplicate.

Two consequences follow, and both matter:

* **Failure is safe.** If this plugin does not load, the harness keeps the stock
  filesystem and sandbox rather than losing them. (The alternative — disabling
  the stock rows and inserting replacements — has no such fallback, and Cordis
  refuses to register two providers of the same service name, so it cannot be
  made safe by shadowing.)
* **It is additive.** The stock check stays authoritative for every case it
  already handled; only its own denial is reconsidered.

## Configuration

Both surfaces are supported.

### Profile config

```yaml
- id: extra-sandbox-presets
  name: dsh-extra-sandbox-presets
  config:
    presets:
      # The session workspace plus a few caches.
      workspace-write-extra:
        writableDirs:
          - /srv/shared-assets
          - ~/notes
      # No workspace write at all; only these two directories.
      scratch:
        sandbox: read-only
        approval: never
        writableDirs:
          - /tmp
          - ~/scratch
      # A relabelled entry: the client shows `name`, falling back to the key.
      rust-tools:
        sandbox: workspace-write
        writableDirs: [~/.cargo, ~/.rustup]
        name: Rust tools
        description: Workspace plus the cargo and rustup caches
```

| Field | Default | Meaning |
| --- | --- | --- |
| `sandbox` | `workspace-write` | `read-only`, `workspace-write`, or `danger-full-access` |
| `approval` | `ask` | `ask` or `never` |
| `writableDirs` | `[]` | Directories writable on top of the selected mode |
| `name` | the preset key | Optional display label |
| `description` | none | Optional one-line description |

Omit `name` unless you want a specific label: the picker derives its text from
the preset key otherwise (`workspace-write-extra` renders as
`Workspace Write Extra`), while a supplied label is shown verbatim, in English,
because the client localizes only its own built-in presets.

Directories must be absolute; a leading `~` is expanded. Symlinks are resolved,
and a missing or non-directory entry is **ignored with a warning** rather than
created — granting a path nobody named would be the unsafe direction. Expansion
is asynchronous, so a directory only becomes writable after its own successful
expansion. A preset whose `sandbox` or `approval` is not one of the values above
is likewise refused with a warning instead of being published, as are the
reserved names `custom` and `auto`.

`writableDirs` only has an effect under a confined mode. A preset selecting
`danger-full-access` may list them — they stay visible in the table — but that
mode confines nothing, so they grant nothing extra and the model-facing note is
left untouched.

Preset order is configuration order, which is the order the picker offers them.

### Settings page

`presets` is a volatile field, so the whole table also appears on the Settings
page and edits apply live to every session in the profile. The page edits it as
one document rather than as a nested form, so the profile patch above stays the
natural place to write it.

## Compatibility with the harness

This plugin declares no `@deepseek-ai/dsh-*` peer range, and the harness checks
only such peers. Its compatibility therefore rests on something narrower and
more exact: **the shape of two mounted services** (plus one event and one
context name). That shape is what the code actually uses, and the service half
is pinned by `test/contract.test.ts` against the real classes, so a harness
upgrade that moves any of it fails the suite immediately rather than narrowing a
preset in production.

| Depends on | Used by |
| --- | --- |
| `fs.checkedTarget(target, policy)` rejects with code `FS_SANDBOX_DENIED` | `src/fs.ts` |
| `fs.resolve(path)` resolves a target carrying `targetKey` | `src/fs.ts` |
| `sandbox.confine(argv, policy, signal)` resolves to an object carrying `argv` | `src/provider.ts` |
| Policy fields `mode` and `sessionId`; result field `argv` | both wrappers |
| `permissionPresets.presets` and `emitCatalogChanged()` | `src/service.ts` |
| The `system-prompt/assemble` waterfall, and a `sandbox:policy` context to correct in it | `src/service.ts` |

Two properties keep this robust across upgrades:

* The wrappers call the stock methods through `await`, so a stock method that
  changes between synchronous and asynchronous keeps working.
* Both wrappers operate on the returned object rather than assuming a bare argv,
  so a return value that grows fields keeps working.

When a mounted service does not expose the expected seam at all, the plugin
**reports it once per service** and leaves the instance untouched. It never
disables a stock row, so the failure mode of any unexpected harness shape is a
logged warning and stock behaviour — never a missing filesystem or sandbox.

## Platform support

* **Linux with `bwrap`** — fully supported. The configured directories join the
  bubblewrap profile as `--bind <dir> <dir>`, so confined commands agree with the
  write/edit tools.
* **Linux with `landlock`, and macOS `seatbelt`** — the write/edit tools are
  widened, but confined commands are not, because those profiles are built
  inside packages this plugin cannot extend. A warning is logged once instead of
  pretending otherwise.
* **Windows** — not supported.

## Layout

| File | Role |
| --- | --- |
| `src/service.ts` | `ctx.sandboxPresets`: owns the configured preset table, decides per session which preset applies, wraps the two enforcement services, publishes the presets, and corrects the stock sandbox note on the assembly waterfall. |
| `src/presets.ts` | Normalizes the configured table and expands each preset's directories. |
| `src/fs.ts` | Wraps the live filesystem's containment check. |
| `src/provider.ts` | Wraps the live sandbox provider's `confine`. |
| `src/roots.ts` | Path expansion and containment checks. |
| `src/plan.ts` | Pure bwrap argv transformation. |
| `cordis.patch.yml` | Inserts the one plugin row. |
| `test/contract.test.ts` | Pins the harness seams this plugin extends. |

`lib/` is the compiled output of `src/` (`tsc -p tsconfig.build.json`) and is
git-ignored: it is a build artifact, and `src/` is the only source of truth.
`prepare` builds it, so `pnpm install` inside the repository produces `lib/`.
Edit `src/`, never `lib/`.

Note that the profile installs this package by **symlink** (`link:`), pointing at
this working tree, and pnpm runs no lifecycle script for a `link:` dependency —
so an install through the profile does not build. Build here, in the repository,
and the linked profile picks up whatever `lib/` currently holds.

## Build

```
pnpm run build      # tsc -p tsconfig.build.json -> lib/
pnpm run typecheck  # tsc -p tsconfig.json (src + test)
```

## Tests

```
node --test test/
```

`src/roots.ts`, `src/plan.ts`, `src/presets.ts`, and the two wrappers are
dependency-free and run anywhere. The contract and integration suites need the
DSH packages to be resolvable, so they run from an installed profile: the
contract suite pins the real stock seams, and the integration suite assembles the
real filesystem and sandbox provider and asserts both the widening and its exact
reversal on unload. Every suite that needs those packages skips with a reason
when they are absent, and never passes vacuously. The suite runs against the
compiled `lib/`, so run `pnpm run build` first.
