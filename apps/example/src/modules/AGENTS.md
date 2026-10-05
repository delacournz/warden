# Modules

Domain code lives in `src/modules/{domain}/`. Each module groups colocated code for a single feature or domain (e.g. `auth`, `onboarding`, `settings`).

## Module structure

Create subfolders **on demand** — only when a module actually needs them:

| Folder        | Purpose                                         |
| ------------- | ----------------------------------------------- |
| `components/` | React Native components specific to this module |
| `sheets/`     | Bottom sheets / modals owned by this module     |
| `contexts/`   | React contexts scoped to this module            |
| `hooks/`      | Custom hooks that encapsulate module logic      |
| `utils/`      | Pure helpers, formatters, parsers               |

Additional folders that may appear as a module grows: `providers/`, `assets/`, plus top-level files like `types.ts` and `index.ts` (barrel export).

## Rules

- One domain per module. If a concept spans two domains, extract a shared module rather than cross-importing between siblings.
- Route files under `src/app/` should stay thin — import UI from the relevant module.
- No barrel (`index.ts`) is required, but when present, re-export the module's public API only (not internal helpers).
- Do not create empty folders. Add a subfolder the first time you put a file in it.
- Colocate tests: `{name}.test.ts` next to `{name}.ts`.

## Example layout

```text
src/modules/
  auth/
    components/
      auth.container.tsx
    hooks/
      use-auth.ts
    index.ts
  trade/
    components/
      trade-amount-input.tsx
    sheets/
      confirmation.bottom-sheet.tsx
    hooks/
      use-trade-submit.ts
    utils/
      get-user-friendly-error.ts
```
