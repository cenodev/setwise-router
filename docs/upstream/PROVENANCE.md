# ZFi upstream provenance

Setwise Router starts from an immutable import of the ZFi router stack. The
upstream tree lives at [`zFi-main/`](../../zFi-main) and must not be edited in
place for Setwise features — fork or overlay changes elsewhere so `zFi-main`
remains a clean differential reference.

## Snapshot

| Field | Value |
| --- | --- |
| Upstream repository | https://github.com/z-fi/zFi |
| Pinned commit | `43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3` |
| Commit URL | https://github.com/z-fi/zFi/commit/43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3 |
| Commit subject | `api/render` |
| Committed at (UTC) | 2026-06-10T07:53:46Z |
| License | MIT (`Copyright (c) 2026 ZAMM`) |
| Local path | `zFi-main/` (git submodule) |

Machine-readable copy: [`PROVENANCE.json`](./PROVENANCE.json).

## Nested dependency

Upstream pins Foundry's `forge-std` via git submodule:

| Field | Value |
| --- | --- |
| Path | `zFi-main/lib/forge-std` |
| URL | https://github.com/foundry-rs/forge-std |
| Commit | `0844d7e1fc5e60d77b68e469bff60265f236c398` |

## Required ZFi layers present in this snapshot

1. **Router** — `zFi-main/src/zRouter.sol`
2. **On-chain quoter** — `zFi-main/src/zQuoter.sol`
3. **Quote service** — `zFi-main/server/quote.js` (+ `server/index.js`, `server/pin.js`)
4. **Dapp routing modules** — `zFi-main/dapp/` (including `dapp/modules/`) and on-chain HTML `zFi-main/zSwap.html`
5. **Tests** — `zFi-main/test/`
6. **Scripts** — `zFi-main/script/`
7. **Audit notes** — `zFi-main/audit/` (`zRouter/`, `DutchAuction/`)
8. **License** — `zFi-main/LICENSE`

## Reproduce the imported snapshot

```bash
git clone --recurse-submodules https://github.com/cenodev/setwise-router.git
cd setwise-router
git submodule update --init --recursive

# Confirm the pinned upstream revision
git -C zFi-main rev-parse HEAD
# → 43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3

# Optional: rebuild the same tree from upstream alone
git clone https://github.com/z-fi/zFi.git /tmp/zFi-check
git -C /tmp/zFi-check checkout 43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3
git -C /tmp/zFi-check submodule update --init --recursive
diff -rq --exclude=.git zFi-main /tmp/zFi-check

# Build the untouched baseline (requires Foundry)
cd zFi-main && forge build
```

Or from this repository after clone:

```bash
npm test          # provenance + required-layer checks
npm run build     # forge build inside zFi-main
```

## Differential comparisons

Keep `zFi-main` on the pinned commit. Compare Setwise working trees against it
with path filters that ignore build outputs (`cache/`, `out/`) and nested
`lib/forge-std` unless the dependency pin itself changed.
