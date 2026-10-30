//! Byte-compatible with src/lib/core/crypto.ts so existing password hashes and sessions remain valid.
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;
const N_LOG2: u8 = 14; // N = 16384
const R: u32 = 8;
const P: u32 = 1;
const KEY_LEN: usize = 64;

pub fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

pub fn create_id(prefix: &str) -> String { format!("{prefix}_{}", random_hex(10)) }

pub fn sha256_hex(input: &str) -> String { hex::encode(Sha256::digest(input.as_bytes())) }

fn scrypt_raw(password: &str, salt: &str, n: u64, r: u32, p: u32) -> Option<Vec<u8>> {
    if !n.is_power_of_two() || n < 2 { return None; }
    let log_n = n.trailing_zeros() as u8;
    let params = scrypt::Params::new(log_n, r, p, KEY_LEN).ok()?;
    let mut out = vec![0u8; KEY_LEN];
    // Node passes the hex salt *string*, i.e. its UTF-8 bytes: reproduce exactly.
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).ok()?;
    Some(out)
}

pub fn hash_password(password: &str) -> String {
    let salt = random_hex(16);
    let d = scrypt_raw(password, &salt, 1u64 << N_LOG2, R, P).expect("scrypt params valid");
    format!("scrypt${}${}${}${}${}", 1u64 << N_LOG2, R, P, salt, hex::encode(d))
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 6 || parts[0] != "scrypt" { return false; }
    let (Ok(n), Ok(r), Ok(p)) = (parts[1].parse::<u64>(), parts[2].parse::<u32>(), parts[3].parse::<u32>()) else { return false };
    if n > (1 << 20) { return false; }
    let Ok(expected) = hex::decode(parts[5]) else { return false };
    let Some(d) = scrypt_raw(password, parts[4], n, r, p) else { return false };
    d.len() == expected.len() && bool::from(d.ct_eq(&expected))
}

fn hmac_hex(secret: &str, msg: &str) -> String {
    let mut m = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key");
    m.update(msg.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

/// Returns (raw_token, token_hash). raw = tokenId.hmac(tokenId)
pub fn generate_session_token(secret: &str) -> (String, String) {
    let id = random_hex(32);
    let raw = format!("{id}.{}", hmac_hex(secret, &id));
    let h = sha256_hex(&raw);
    (raw, h)
}

pub fn verify_session_token_format(secret: &str, raw: &str) -> bool {
    let Some((id, mac)) = raw.split_once('.') else { return false };
    if id.len() != 64 || mac.len() != 64 || mac.contains('.') { return false; }
    let expected = hmac_hex(secret, id);
    bool::from(mac.as_bytes().ct_eq(expected.as_bytes()))
}

pub fn derive_csrf_token(secret: &str, raw_session: &str) -> String {
    hmac_hex(secret, &format!("solob-csrf-v1:{raw_session}"))
}

pub fn verify_csrf_token(secret: &str, raw_session: &str, candidate: &str) -> bool {
    if raw_session.is_empty() || candidate.is_empty() { return false; }
    let e = derive_csrf_token(secret, raw_session);
    let c = candidate.trim();
    e.len() == c.len() && bool::from(e.as_bytes().ct_eq(c.as_bytes()))
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    // Compare digests so length differences do not leak through early exit.
    let (x, y) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    bool::from(x.ct_eq(&y))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_roundtrip_and_format() {
        let h = hash_password("Sup3rSecret!");
        assert!(h.starts_with("scrypt$16384$8$1$"));
        assert!(verify_password("Sup3rSecret!", &h));
        assert!(!verify_password("wrong", &h));
        assert!(!verify_password("x", "garbage"));
    }
    #[test]
    fn verifies_hash_produced_by_node() {
        // Generated with Node: crypto.scryptSync('Password123!', 'abcdef0123456789abcdef0123456789', 64, {N:16384,r:8,p:1})
        let h = include_str!("../tests/fixtures/node_scrypt_hash.txt").trim();
        assert!(verify_password("Password123!", h));
    }
    #[test]
    fn session_and_csrf() {
        let (raw, hash) = generate_session_token("k");
        assert_eq!(hash, sha256_hex(&raw));
        assert!(verify_session_token_format("k", &raw));
        assert!(!verify_session_token_format("other", &raw));
        let c = derive_csrf_token("k", &raw);
        assert!(verify_csrf_token("k", &raw, &c));
        assert!(!verify_csrf_token("k", &raw, "nope"));
    }
}
