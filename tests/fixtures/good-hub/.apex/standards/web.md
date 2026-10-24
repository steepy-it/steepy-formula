# web standard

> Owning surface: `web`.

## Conventions

- Every external value must be sanitized before it is written to disk.
- Session cookies should expire after thirty minutes of inactivity.

## Anti-patterns

- Frontend code must never block on the network during page load.

## Testing

The narrowest validation that can falsify a change here:

```sh
node --test tests/web.test.mjs
```
