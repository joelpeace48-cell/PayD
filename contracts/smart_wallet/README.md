# Smart Wallet Contract

This contract account example supports mixed signer sets:

- Stellar Ed25519 account keys
- secp256k1 public keys for Ethereum-style wallets and bridge tooling

## Signing payloads

Soroban passes a 32-byte `Hash<32>` into `__check_auth`. Sign that exact payload, and do not add any extra prefix or chain-specific message formatting unless the contract explicitly hashes it first.

### Ed25519

- Sign the raw 32-byte payload bytes.
- Provide the 32-byte Ed25519 public key and 64-byte signature.

### secp256k1

- Sign the same 32-byte payload digest with ECDSA secp256k1.
- Provide the 65-byte SEC-1 public key and 64-byte compact signature.
- The wallet should sign the exact payload the contract receives. Do not use `personal_sign`-style prefixes unless the contract is designed to expect them.

## Benchmarking

The test suite includes budget-printing checks for both Ed25519 and secp256k1 verification so you can compare CPU instruction usage in the Soroban test environment.
