# pi-x

nifty [pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Extensions

| Name                       | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| [task](./extensions/task/) | `/task` — independently verified goal loops with retry backoff |

The root package discovers extensions from `./extensions`. See each extension's README for usage and configuration.

## Installing

```bash
pi install git:github.com/cdaringe/pi-x
```

## Development

```bash
corepack pnpm install
npm run format
npm run format:check
npm run typecheck
npm test
npm run knip
```

Biome formats code and sorts object properties and TypeScript interface members. Knip checks for unused files, exports, and dependencies.
