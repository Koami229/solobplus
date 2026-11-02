//! Parité Rust (candle) vs PyTorch : logits sur prompts fixes (tolérance absolue 1e-4), tokenisation identique
//! (SentencePiece Python vs Rust) et continuation gloutonne identique. Fixture produite par tools/export_weights.py.
//! SOLOB_LOCAL_PARITY_DIRS = dossiers séparés par ':' (CI: modèle aléatoire minuscule; local: aussi le modèle promu).
use candle_core::{safetensors, Device, IndexOp};
use std::path::Path;

const TOL: f32 = 1e-4;

fn dirs() -> Vec<String> {
    match std::env::var("SOLOB_LOCAL_PARITY_DIRS") {
        Ok(v) => v.split(':').filter(|s| !s.is_empty()).map(String::from).collect(),
        Err(_) => { if std::env::var("CI").is_ok() { panic!("SOLOB_LOCAL_PARITY_DIRS requis en CI") } eprintln!("SKIP: SOLOB_LOCAL_PARITY_DIRS unset"); vec![] }
    }
}

#[test]
fn logits_tokens_and_greedy_match_pytorch() {
    for d in dirs() {
        let dir = Path::new(&d);
        let eng = solob_local::Engine::load(dir).unwrap();
        let fx: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("parity.json")).unwrap()).unwrap();
        let refs = safetensors::load(dir.join("parity.safetensors"), &Device::Cpu).unwrap();
        let (mut worst, mut n) = (0f32, 0usize);
        for (i, c) in fx["cases"].as_array().unwrap().iter().enumerate() {
            let ids: Vec<u32> = c["ids"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
            let rust_ids = eng.encode(c["lang"].as_str().unwrap(), c["prompt"].as_str().unwrap()).unwrap();
            let max = eng.model.cfg.max_seq_len; let rust_ids = rust_ids[rust_ids.len().saturating_sub(max)..].to_vec();
            assert_eq!(rust_ids, ids, "tokenisation différente (cas {i})");
            let got = eng.model.logits(&ids).unwrap();
            let want = &refs[&format!("logits_{i}")];
            assert_eq!(got.dims(), want.dims());
            let diff = (got - want).unwrap().abs().unwrap().flatten_all().unwrap().max(0).unwrap().to_scalar::<f32>().unwrap();
            worst = worst.max(diff); n += want.elem_count();
            assert!(diff <= TOL, "cas {i}: écart max {diff} > {TOL}");
            let _ = want.i(0).unwrap();
            let greedy: Vec<u32> = c["greedy"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
            let mut x = ids.clone(); let mut g = Vec::new();
            for _ in 0..greedy.len() { let t = eng.model.next_greedy(&x).unwrap(); g.push(t); x.push(t); }
            assert_eq!(g, greedy, "continuation gloutonne différente (cas {i})");
        }
        println!("PARITY {d}: model={} cases={} logits={n} max_abs_diff={worst:e} tol={TOL:e}", eng.id, fx["cases"].as_array().unwrap().len());
    }
}

#[test]
fn tampered_files_are_refused() {
    for d in dirs() {
        let tmp = std::env::temp_dir().join(format!("solob-local-tamper-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp); std::fs::create_dir_all(&tmp).unwrap();
        for e in std::fs::read_dir(&d).unwrap() { let f = e.unwrap().file_name(); std::fs::copy(Path::new(&d).join(&f), tmp.join(&f)).unwrap(); }
        assert!(solob_local::verify_manifest(&tmp).is_ok());
        let mut b = std::fs::read(tmp.join("model.safetensors")).unwrap(); let l = b.len(); b[l - 1] ^= 0xff;
        std::fs::write(tmp.join("model.safetensors"), b).unwrap();
        assert!(solob_local::Engine::load(&tmp).is_err());
        std::fs::remove_dir_all(&tmp).unwrap();
        return;
    }
}
