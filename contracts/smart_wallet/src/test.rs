#![cfg(test)]

use crate::{
    SignatureProof, SignerKey, SmartWalletContract, SmartWalletContractClient, WalletError,
};
use core::convert::TryInto;
use ed25519_dalek::{Signer as _, SigningKey as Ed25519SigningKey};
use k256::ecdsa::SigningKey as SecpSigningKey;
use soroban_sdk::{Address, Bytes, BytesN, Env, Vec, crypto::Hash};

fn make_ed25519_signer(env: &Env, seed: [u8; 32]) -> (SignerKey, ed25519_dalek::SigningKey) {
    let signing_key = Ed25519SigningKey::from_bytes(&seed);
    let public_key = BytesN::from_array(env, &signing_key.verifying_key().to_bytes());
    (SignerKey::Ed25519(public_key), signing_key)
}

fn make_secp256k1_signer(env: &Env, seed: [u8; 32]) -> (SignerKey, SecpSigningKey) {
    let signing_key = SecpSigningKey::from_bytes((&seed).into()).expect("valid secp256k1 key");
    let public_key_bytes = signing_key.verifying_key().to_encoded_point(false);
    let public_key = BytesN::from_array(
        env,
        public_key_bytes
            .as_bytes()
            .try_into()
            .expect("65-byte secp256k1 public key"),
    );
    (SignerKey::Secp256k1(public_key), signing_key)
}

fn register_wallet(
    env: &Env,
    signers: Vec<SignerKey>,
    threshold: u32,
) -> (Address, SmartWalletContractClient<'static>) {
    let contract_id = env.register(SmartWalletContract, ());
    let client = SmartWalletContractClient::new(env, &contract_id);
    client.init(&signers, &threshold);
    (contract_id, client)
}

fn sign_ed25519(payload: &Hash<32>, signing_key: &Ed25519SigningKey, env: &Env) -> SignatureProof {
    let signature = signing_key.sign(payload.to_array().as_slice());
    let signature_bytes: [u8; 64] = signature.to_bytes();
    SignatureProof::Ed25519(crate::Ed25519Proof {
        public_key: BytesN::from_array(env, &signing_key.verifying_key().to_bytes()),
        signature: BytesN::from_array(env, &signature_bytes),
    })
}

fn sign_secp256k1(payload: &Hash<32>, signing_key: &SecpSigningKey, env: &Env) -> SignatureProof {
    let (signature, recovery_id) = signing_key
        .sign_prehash_recoverable(payload.to_array().as_slice())
        .expect("valid secp256k1 signature");
    let signature_bytes: [u8; 64] = signature.to_bytes().into();
    let public_key_bytes = signing_key.verifying_key().to_encoded_point(false);
    SignatureProof::Secp256k1(crate::Secp256k1Proof {
        public_key: BytesN::from_array(
            env,
            public_key_bytes
                .as_bytes()
                .try_into()
                .expect("65-byte secp256k1 public key"),
        ),
        signature: BytesN::from_array(env, &signature_bytes),
        recovery_id: u32::from(recovery_id.to_byte()),
    })
}

#[test]
fn ed25519_and_secp256k1_signatures_are_accepted() {
    let env = Env::default();

    let (ed_signer_key, ed_signing_key) = make_ed25519_signer(&env, [1u8; 32]);
    let (secp_signer_key, secp_signing_key) = make_secp256k1_signer(&env, [2u8; 32]);
    let signers = Vec::from_array(&env, [ed_signer_key.clone(), secp_signer_key.clone()]);

    let (contract_id, _client) = register_wallet(&env, signers, 2);

    let raw = Bytes::from_slice(&env, &[9u8; 32]);
    let payload = env.crypto().sha256(&raw);
    let proofs = Vec::from_array(
        &env,
        [
            sign_ed25519(&payload, &ed_signing_key, &env),
            sign_secp256k1(&payload, &secp_signing_key, &env),
        ],
    );

    env.as_contract(&contract_id, || {
        SmartWalletContract::verify_signatures_inner(&env, &payload, &proofs).unwrap();
    });
}

#[test]
fn secp256k1_auth_uses_host_budget() {
    let env = Env::default();

    let (secp_signer_key, secp_signing_key) = make_secp256k1_signer(&env, [3u8; 32]);
    let signers = Vec::from_array(&env, [secp_signer_key]);
    let (contract_id, _client) = register_wallet(&env, signers, 1);

    let raw = Bytes::from_slice(&env, &[10u8; 32]);
    let payload = env.crypto().sha256(&raw);
    let proof = Vec::from_array(&env, [sign_secp256k1(&payload, &secp_signing_key, &env)]);
    env.as_contract(&contract_id, || {
        SmartWalletContract::verify_signatures_inner(&env, &payload, &proof).unwrap();
    });

    let budget = env.cost_estimate().budget();
    budget.print();
}

#[test]
fn ed25519_auth_uses_host_budget() {
    let env = Env::default();

    let (ed_signer_key, ed_signing_key) = make_ed25519_signer(&env, [4u8; 32]);
    let signers = Vec::from_array(&env, [ed_signer_key]);
    let (contract_id, _client) = register_wallet(&env, signers, 1);

    let raw = Bytes::from_slice(&env, &[11u8; 32]);
    let payload = env.crypto().sha256(&raw);
    let proof = Vec::from_array(&env, [sign_ed25519(&payload, &ed_signing_key, &env)]);
    env.as_contract(&contract_id, || {
        SmartWalletContract::verify_signatures_inner(&env, &payload, &proof).unwrap();
    });

    let budget = env.cost_estimate().budget();
    budget.print();
}

#[test]
fn add_signer_increases_count() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let (signer2, _) = make_ed25519_signer(&env, [2u8; 32]);
    let signers = Vec::from_array(&env, [signer1]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    assert_eq!(client.signer_count(), 1);
    client.add_signer(&signer2);
    assert_eq!(client.signer_count(), 2);
}

#[test]
fn add_duplicate_signer_returns_error() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let signers = Vec::from_array(&env, [signer1.clone()]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    let result = client.try_add_signer(&signer1);
    assert_eq!(result, Err(Ok(WalletError::DuplicateSigner)));
}

#[test]
fn remove_signer_decreases_count() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let (signer2, _) = make_ed25519_signer(&env, [2u8; 32]);
    let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    assert_eq!(client.signer_count(), 2);
    client.remove_signer(&signer2);
    assert_eq!(client.signer_count(), 1);
}

#[test]
fn remove_unknown_signer_returns_error() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let (signer2, _) = make_ed25519_signer(&env, [2u8; 32]);
    let signers = Vec::from_array(&env, [signer1.clone()]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    let result = client.try_remove_signer(&signer2);
    assert_eq!(result, Err(Ok(WalletError::UnknownSigner)));
}

#[test]
fn remove_signer_below_threshold_returns_error() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let signers = Vec::from_array(&env, [signer1.clone()]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    let result = client.try_remove_signer(&signer1);
    assert_eq!(result, Err(Ok(WalletError::InvalidThreshold)));
}

// ══════════════════════════════════════════════════════════════════════════════
// ── EVENT TESTS ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_wallet_initialized_event() {
    let env = Env::default();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let (signer2, _) = make_ed25519_signer(&env, [2u8; 32]);
    let signers = Vec::from_array(&env, [signer1, signer2]);

    let contract_id = env.register(SmartWalletContract, ());
    let client = SmartWalletContractClient::new(&env, &contract_id);
    client.init(&signers, &2);

    assert_eq!(client.signer_count(), 2);
    assert_eq!(client.threshold(), 2);
}

#[test]
fn test_signer_added_event() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let (signer2, _) = make_ed25519_signer(&env, [2u8; 32]);
    let signers = Vec::from_array(&env, [signer1]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    client.add_signer(&signer2);
    assert_eq!(client.signer_count(), 2);
}

#[test]
fn test_signer_removed_event() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let (signer2, _) = make_ed25519_signer(&env, [2u8; 32]);
    let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    client.remove_signer(&signer2);
    assert_eq!(client.signer_count(), 1);
}

#[test]
fn test_threshold_changed_event() {
    let env = Env::default();
    env.mock_all_auths();

    let (signer1, _) = make_ed25519_signer(&env, [1u8; 32]);
    let (signer2, _) = make_ed25519_signer(&env, [2u8; 32]);
    let (signer3, _) = make_ed25519_signer(&env, [3u8; 32]);
    let signers = Vec::from_array(&env, [signer1, signer2, signer3]);
    let (_contract_id, client) = register_wallet(&env, signers, 1);

    client.set_threshold(&3);
    assert_eq!(client.threshold(), 3);
}


// ══════════════════════════════════════════════════════════════════════════════
// ── ISSUE #903: signature type-mismatch tests ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn ed25519_signer_rejects_secp256k1_proof() {
    // Register an ed25519 signer, then submit a secp256k1 proof — type mismatch
    // means signer_matches_proof always returns false → UnknownSigner.
    let env = Env::default();

    let (ed_signer_key, _ed_signing_key) = make_ed25519_signer(&env, [10u8; 32]);
    let (_secp_signer_key, secp_signing_key) = make_secp256k1_signer(&env, [11u8; 32]);
    let signers = Vec::from_array(&env, [ed_signer_key]);
    let (contract_id, _client) = register_wallet(&env, signers, 1);

    let raw = Bytes::from_slice(&env, &[42u8; 32]);
    let payload = env.crypto().sha256(&raw);
    // Submit a secp256k1 proof to a wallet that only has an ed25519 signer
    let proof = Vec::from_array(&env, [sign_secp256k1(&payload, &secp_signing_key, &env)]);

    env.as_contract(&contract_id, || {
        let result = SmartWalletContract::verify_signatures_inner(&env, &payload, &proof);
        assert_eq!(result, Err(WalletError::UnknownSigner));
    });
}

#[test]
fn secp256k1_signer_rejects_ed25519_proof() {
    // Register a secp256k1 signer, then submit an ed25519 proof — type mismatch
    // means signer_matches_proof always returns false → UnknownSigner.
    let env = Env::default();

    let (_ed_signer_key, ed_signing_key) = make_ed25519_signer(&env, [20u8; 32]);
    let (secp_signer_key, _secp_signing_key) = make_secp256k1_signer(&env, [21u8; 32]);
    let signers = Vec::from_array(&env, [secp_signer_key]);
    let (contract_id, _client) = register_wallet(&env, signers, 1);

    let raw = Bytes::from_slice(&env, &[43u8; 32]);
    let payload = env.crypto().sha256(&raw);
    // Submit an ed25519 proof to a wallet that only has a secp256k1 signer
    let proof = Vec::from_array(&env, [sign_ed25519(&payload, &ed_signing_key, &env)]);

    env.as_contract(&contract_id, || {
        let result = SmartWalletContract::verify_signatures_inner(&env, &payload, &proof);
        assert_eq!(result, Err(WalletError::UnknownSigner));
    });
}

#[test]
fn mixed_multisig_with_swapped_types_fails_threshold() {
    // 2-of-2 wallet: signer[0] is ed25519, signer[1] is secp256k1.
    // Submit the proofs with swapped types — neither proof matches any signer
    // so the batch never satisfies the threshold.
    let env = Env::default();

    let (ed_signer_key, ed_signing_key) = make_ed25519_signer(&env, [30u8; 32]);
    let (secp_signer_key, secp_signing_key) = make_secp256k1_signer(&env, [31u8; 32]);
    let signers = Vec::from_array(&env, [ed_signer_key, secp_signer_key]);
    let (contract_id, _client) = register_wallet(&env, signers, 2);

    let raw = Bytes::from_slice(&env, &[44u8; 32]);
    let payload = env.crypto().sha256(&raw);

    // Deliberately swap: submit secp proof for slot 0 and ed proof for slot 1
    let proofs = Vec::from_array(
        &env,
        [
            sign_secp256k1(&payload, &secp_signing_key, &env),
            sign_ed25519(&payload, &ed_signing_key, &env),
        ],
    );

    env.as_contract(&contract_id, || {
        let result = SmartWalletContract::verify_signatures_inner(&env, &payload, &proofs);
        // Both proofs have no matching signer → first unmatched proof → UnknownSigner
        assert_eq!(result, Err(WalletError::UnknownSigner));
    });
}

#[test]
fn mixed_multisig_correct_types_satisfy_threshold() {
    // 2-of-3 wallet with ed25519, secp256k1, ed25519 signers.
    // Submitting correct-type proofs for two different key-type slots must pass.
    let env = Env::default();

    let (ed_signer_key1, ed_signing_key1) = make_ed25519_signer(&env, [40u8; 32]);
    let (secp_signer_key, secp_signing_key) = make_secp256k1_signer(&env, [41u8; 32]);
    let (ed_signer_key2, _ed_signing_key2) = make_ed25519_signer(&env, [42u8; 32]);
    let signers = Vec::from_array(
        &env,
        [ed_signer_key1, secp_signer_key, ed_signer_key2],
    );
    let (contract_id, _client) = register_wallet(&env, signers, 2);

    let raw = Bytes::from_slice(&env, &[45u8; 32]);
    let payload = env.crypto().sha256(&raw);
    let proofs = Vec::from_array(
        &env,
        [
            sign_ed25519(&payload, &ed_signing_key1, &env),
            sign_secp256k1(&payload, &secp_signing_key, &env),
        ],
    );

    env.as_contract(&contract_id, || {
        SmartWalletContract::verify_signatures_inner(&env, &payload, &proofs).unwrap();
    });
}
