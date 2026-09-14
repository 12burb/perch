# @perch/vault

Envelope encryption for every stored secret (spec §2): AES-256-GCM through WebCrypto, a per-secret data
key wrapped by the root key from `PERCH_MASTER_KEY`, and rotation that re-wraps data keys without
re-encrypting payloads. KMS and age providers land behind the same `Vault` interface later.

```ts
const vault = createVault({ masterKey: process.env.PERCH_MASTER_KEY });
const ciphertext = await vault.encrypt(accessToken, `connections:${id}`); // aad binds the context
const token = await vault.decryptString(ciphertext, `connections:${id}`);
const rotated = await vault.rewrap(ciphertext, createVault({ masterKey: nextKey }));
```

`generateMasterKey()` produces the 32-byte base64 key `perch init` writes; `createRotatingVault([next,
current])` reads both during a rotation and `rewrapToCurrent` migrates rows. The wire format is
`"PV" | version | keyId(8) | wrappedDek(60) | iv(12) | ciphertext+tag`; nothing about it depends on the
database.
