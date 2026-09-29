# dsh-workspace-write-extra

Adds a fourth permission preset to DeepSeek Harness that grants write access to
configured directories **in addition to** the session workspace.

The three stock sandbox modes are not modified in any way: `read-only`,
`workspace-write`, and `danger-full-access` keep their exact meaning, their
persisted schemas, and their escalation ladder.

## What it adds

One more entry in the permission picker:

| Preset | Sandbox mode | Approval | Writes |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `ask` | nothing |
| `workspace-write` | `workspace-write` | `ask` | workspace + temp areas |
| `workspace-write-extra` | `workspace-write` | `ask` | the above **+ configured directories** |
| `danger-full-access` | `danger-full-access` | `never` | everything |

The entry carries no label, so the picker derives its text from the preset name
and renders `Workspace Write Extra`, matching how the built-in entries read. A
label supplied here would be shown verbatim, in English, because the client
localizes only its own built-in presets and the `auto` preset.

The new preset is a *permission preset*, not a fourth `SandboxMode`. That
distinction is the whole point: the sandbox mode vocabulary is a closed
three-value union that is written into `sandbox/mode` session events and
re-validated by several foreign projections when a session is restored. A fourth
value there would make every session that used it unreadable. Bundling the
existing `workspace-write` mode with extra behaviour is the same approach the
shipped `auto` preset takes.

Enablement is per session: the extra directories apply while that session's last
recorded permission preset is `workspace-write-extra`, which survives a restart
because the choice lives in the session log.

## How it stays out of the way

The plugin does not disable, replace, or reorder any stock row. It wraps the two
live enforcement services **in place**, and unwraps them exactly on unload:

* the mounted filesystem's containment check (`checkedTarget`) gains a retry of
  its `workspace-write` denial against the extra directories;
* the sandbox provider's `confine` gains the matching `--bind` pairs in the
  bwrap profile.

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
- id: workspace-write-extra
  name: dsh-workspace-write-extra
  config:
    extraWritableDirs:
      - /srv/shared-assets
      - ~/notes
    presetName: workspace-write-extra
```

Entries must be absolute; a leading `~` is expanded. Symlinks are resolved, and
a missing or non-directory entry is **ignored with a warning** rather than
created — granting a path nobody named would be the unsafe direction. Expansion
is asynchronous, so a directory only becomes writable after its own successful
expansion.

### Settings page

`extraWritableDirs` is a volatile field, so it also appears on the Settings page
and edits apply live to every session in the profile.

## Compatibility with the harness

This plugin declares no `@deepseek-ai/dsh-*` peer range, and the harness checks
only such peers. Its compatibility therefore rests on something narrower and
more exact: **the shape of two mounted services**. That shape is what the code
actually uses, and it is pinned by `test/contract.test.mjs` against the real
classes, so a harness upgrade that moves any of it fails the suite immediately
rather than narrowing the preset in production.

| Depends on | Used by |
| --- | --- |
| `fs.checkedTarget(target, policy)` rejects with code `FS_SANDBOX_DENIED` | `lib/fs.mjs` |
| `fs.resolve(path)` resolves a target carrying `targetKey` | `lib/fs.mjs` |
| `sandbox.confine(argv, policy, signal)` resolves to an object carrying `argv` | `lib/provider.mjs` |
| Policy fields `mode` and `sessionId`; result field `argv` | both wrappers |
| `permissionPresets.presets` and `emitCatalogChanged()` | `lib/service.mjs` |
| `systemPrompt.context()` and `getContextOrder('SANDBOX_POLICY')` | `lib/service.mjs` |

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

* **Linux with `bwrap`** — fully supported. The extra directories join the
  bubblewrap profile as `--bind <dir> <dir>`, so confined commands agree with
  the write/edit tools.
* **Linux with `landlock`, and macOS `seatbelt`** — the write/edit tools are
  widened, but confined commands are not, because those profiles are built
  inside packages this plugin cannot extend. A warning is logged once instead of
  pretending otherwise.
* **Windows** — not supported.

## Layout

| File | Role |
| --- | --- |
| `lib/service.mjs` | `ctx.extraWriteDirs`: owns the configured directories, decides per session whether the preset applies, wraps the two enforcement services, publishes the preset, and adds the model-facing note. |
| `lib/fs.mjs` | Wraps the live filesystem's containment check. |
| `lib/provider.mjs` | Wraps the live sandbox provider's `confine`. |
| `lib/roots.mjs` | Path expansion and containment checks. |
| `lib/plan.mjs` | Pure bwrap argv transformation. |
| `cordis.patch.yml` | Inserts the one plugin row. |
| `test/contract.test.mjs` | Pins the harness seams this plugin extends. |

## Tests

```
node --test test/
```

`roots.mjs`, `plan.mjs`, and the two wrappers are dependency-free and run
anywhere. The contract and integration suites need the DSH packages to be
resolvable, so they run from an installed profile: the contract suite pins the
real stock seams, and the integration suite assembles the real filesystem and
sandbox provider and asserts both the widening and its exact reversal on
unload. Every suite that needs those packages skips with a reason when they are
absent, and never passes vacuously.