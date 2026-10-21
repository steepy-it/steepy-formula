# web standard — core

> Owning surface: `web`. This standard is shipped in the modular folder form: this core doc
> plus one file per sub-area under `standards/web/`.

## Conventions

- The web surface must ship a responsive default layout.

## Sub-areas

| Sub-area | When to read it (path/topic) | Doc |
|---|---|---|
| auth | authentication and session handling | [web-auth.md](web-auth.md) |
| data | database and persistence paths | [web-data.md](web-data.md) |

## Testing

The narrowest validation that can falsify a change here:

```sh
node --test tests/web-core.test.mjs
```
