#![cfg(test)]

use crate::{RevenueSplitContract, RevenueSplitContractClient, RecipientShare};
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env, Vec};
use soroban_sdk::token::Client as TokenClient;
use soroban_sdk::token::StellarAssetClient;

fn create_token_contract<'a>(e: &Env, admin: &Address) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
    e.mock_all_auths();
    let contract_id = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let stellar_asset_client = StellarAssetClient::new(e, &contract_id);
    let token_client = TokenClient::new(e, &contract_id);
    (contract_id, stellar_asset_client, token_client)
}

#[test]
fn test_initialization() {
    let env = Env::default();
    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 6000 },
        RecipientShare { destination: recipient2.clone(), basis_points: 4000 },
    ]);

    client.init(&admin, &shares);

    // Initialized correctly without panic
}

#[test]
#[should_panic(expected = "Shares must sum to 10000 basis points")]
fn test_init_invalid_shares() {
    let env = Env::default();
    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 5000 },
    ]);

    client.init(&admin, &shares);
}

#[test]
#[should_panic(expected = "Duplicate recipient")]
fn test_init_duplicate_recipient_panics() {
    let env = Env::default();
    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient.clone(), basis_points: 5000 },
        RecipientShare { destination: recipient, basis_points: 5000 },
    ]);

    client.init(&admin, &shares);
}

#[test]
fn test_distribution() {
    let env = Env::default();
    env.mock_all_auths();

    // Create token
    let token_admin = Address::generate(&env);
    let (token_id, stellar_asset_client, token_client) = create_token_contract(&env, &token_admin);

    // Setup revenue split contract
    let contract_id = env.register(RevenueSplitContract, ());
    let contract_client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let recipient3 = Address::generate(&env);

    // 50%, 30%, 20%
    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 5000 },
        RecipientShare { destination: recipient2.clone(), basis_points: 3000 },
        RecipientShare { destination: recipient3.clone(), basis_points: 2000 },
    ]);

    contract_client.init(&admin, &shares);

    // Fund a sender
    let sender = Address::generate(&env);
    stellar_asset_client.mint(&sender, &1000);

    // Distribute 1000 tokens
    contract_client.distribute(&token_id, &sender, &1000);

    // Verify balances
    assert_eq!(token_client.balance(&sender), 0);
    assert_eq!(token_client.balance(&recipient1), 500);
    assert_eq!(token_client.balance(&recipient2), 300);
    assert_eq!(token_client.balance(&recipient3), 200);
}

#[test]
fn test_update_recipients() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);

    // Initial 100% to recipient1
    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 10000 },
    ]);
    client.init(&admin, &shares);

    // Update to 2 recipients perfectly
    let recipient2 = Address::generate(&env);
    let new_shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 5000 },
        RecipientShare { destination: recipient2.clone(), basis_points: 5000 },
    ]);

    client.update_recipients(&new_shares);
}

#[test]
#[should_panic(expected = "Recipient share must be greater than zero")]
fn test_update_recipients_rejects_zero_share() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 10000 },
    ]);
    client.init(&admin, &shares);

    let recipient2 = Address::generate(&env);
    let new_shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1, basis_points: 10000 },
        RecipientShare { destination: recipient2, basis_points: 0 },
    ]);

    client.update_recipients(&new_shares);
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_double_init_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient.clone(), basis_points: 10000 },
    ]);

    client.init(&admin, &shares);
    // Second init must panic
    client.init(&admin, &shares);
}

#[test]
fn test_set_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient.clone(), basis_points: 10000 },
    ]);

    client.init(&admin, &shares);
    client.set_admin(&new_admin);
    assert_eq!(client.get_admin(), new_admin);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── LEDGER SEQUENCE VERIFICATION TESTS (Issue #173) ───────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "Distribution already processed in this ledger sequence")]
fn test_distribute_replay_same_ledger() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(50);

    let token_admin = Address::generate(&env);
    let (token_id, stellar_asset_client, _) = create_token_contract(&env, &token_admin);

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient.clone(), basis_points: 10000 },
    ]);

    client.init(&admin, &shares);

    let sender = Address::generate(&env);
    stellar_asset_client.mint(&sender, &2000);

    client.distribute(&token_id, &sender, &1000);
    client.distribute(&token_id, &sender, &500); // Should panic
}

#[test]
fn test_sep0034_metadata() {
    let env = Env::default();
    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    assert_eq!(client.name(), soroban_sdk::String::from_str(&env, env!("CARGO_PKG_NAME")));
    assert_eq!(client.version(), soroban_sdk::String::from_str(&env, env!("CARGO_PKG_VERSION")));
    assert_eq!(client.author(), soroban_sdk::String::from_str(&env, env!("CARGO_PKG_AUTHORS")));
}

#[test]
fn test_distribute_allowed_different_ledgers() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(50);

    let token_admin = Address::generate(&env);
    let (token_id, stellar_asset_client, token_client) = create_token_contract(&env, &token_admin);

    let contract_id = env.register(RevenueSplitContract, ());
    let contract_client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    // 33.33% / 66.67% split — 3333 + 6667 basis points
    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 3333 },
        RecipientShare { destination: recipient2.clone(), basis_points: 6667 },
    ]);

    contract_client.init(&admin, &shares);

    let sender = Address::generate(&env);
    stellar_asset_client.mint(&sender, &1000);

    contract_client.distribute(&token_id, &sender, &1000);

    // sender balance must be fully drained
    assert_eq!(token_client.balance(&sender), 0);
    // combined balances must equal the original 1000
    let r1 = token_client.balance(&recipient1);
    let r2 = token_client.balance(&recipient2);
    assert_eq!(r1 + r2, 1000);
}

#[test]
#[should_panic(expected = "Shares must sum to 10000 basis points")]
fn test_update_recipients_invalid_sum_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 10000 },
    ]);
    client.init(&admin, &shares);

    // Bad update: only sums to 9000
    let recipient2 = Address::generate(&env);
    let bad_shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 4000 },
        RecipientShare { destination: recipient2.clone(), basis_points: 5000 },
    ]);
    client.update_recipients(&bad_shares);
}

#[test]
fn test_distribute_updates_ledger_state() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(50);

    let token_admin = Address::generate(&env);
    let (token_id, stellar_asset_client, token_client) = create_token_contract(&env, &token_admin);

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient.clone(), basis_points: 10000 },
    ]);
    client.init(&admin, &shares);

    let sender = Address::generate(&env);
    stellar_asset_client.mint(&sender, &2000);

    client.distribute(&token_id, &sender, &1000);
    assert_eq!(client.get_last_distribute_ledger(), 50);

    // Advance to a new ledger
    env.ledger().set_sequence_number(51);

    client.distribute(&token_id, &sender, &500);
    assert_eq!(client.get_last_distribute_ledger(), 51);
    assert_eq!(token_client.balance(&recipient), 1500);
}

#[test]
fn test_get_recipients_returns_current_configuration() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 7000 },
        RecipientShare { destination: recipient2.clone(), basis_points: 3000 },
    ]);

    client.init(&admin, &shares);

    let stored = client.get_recipients();
    assert_eq!(stored, shares);
}

#[test]
fn test_preview_distribution_preserves_remainder_on_last_recipient() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 3333 },
        RecipientShare { destination: recipient2.clone(), basis_points: 6667 },
    ]);

    client.init(&admin, &shares);

    let preview = client.preview_distribution(&1000);
    let first = preview.get(0).unwrap();
    let second = preview.get(1).unwrap();

    assert_eq!(first.destination, recipient1);
    assert_eq!(first.amount, 333);
    assert_eq!(second.destination, recipient2);
    assert_eq!(second.amount, 667);
}

#[test]
fn test_total_distributed_accumulates_across_calls() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let (token_contract, token_admin_client, token_client) = create_token_contract(&env, &admin);
    token_admin_client.mint(&sender, &100_000);

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: recipient1.clone(), basis_points: 5000 },
        RecipientShare { destination: recipient2.clone(), basis_points: 5000 },
    ]);
    client.init(&admin, &shares);

    // First distribution
    env.ledger().set_sequence_number(1);
    client.distribute(&token_contract, &sender, &10_000);
    assert_eq!(client.get_total_distributed(&token_contract), 10_000);

    // Second distribution in a different ledger
    env.ledger().set_sequence_number(2);
    client.distribute(&token_contract, &sender, &5_000);
    assert_eq!(client.get_total_distributed(&token_contract), 15_000);

    // Recipients received correct balances
    assert_eq!(token_client.balance(&recipient1), 7_500);
    assert_eq!(token_client.balance(&recipient2), 7_500);
}

#[test]
fn test_total_distributed_starts_at_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let (token_contract, _, _) = create_token_contract(&env, &admin);

    let contract_id = env.register(RevenueSplitContract, ());
    let client = RevenueSplitContractClient::new(&env, &contract_id);

    let shares = Vec::from_array(&env, [
        RecipientShare { destination: Address::generate(&env), basis_points: 10_000 },
    ]);
    client.init(&admin, &shares);

    assert_eq!(client.get_total_distributed(&token_contract), 0);
}
