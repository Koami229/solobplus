//! Décodeur causal SOLOB AI (même architecture que polyglot/solob-ai/solob_ai/model/gpt.py), CPU, float32.
//! Pré-normalisation LayerNorm (eps 1e-5), attention causale multi-têtes, GELU exacte (erf), têtes liées.
use anyhow::{bail, Context, Result};
use candle_core::{DType, Device, IndexOp, Module, Tensor, D};
use candle_nn::{ops::softmax_last_dim, Embedding, LayerNorm, Linear, VarBuilder};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct ModelConfig {
    pub vocab_size: usize,
    pub d_model: usize,
    pub n_layers: usize,
    pub n_heads: usize,
    pub d_ff: usize,
    pub max_seq_len: usize,
    pub tie_embeddings: bool,
    #[serde(default = "eps")] pub layer_norm_eps: f64,
    pub eos_id: i64,
    #[serde(default)] pub n_params: usize,
    #[serde(default)] pub meta: serde_json::Value,
}
fn eps() -> f64 { 1e-5 }

struct Block { n1: LayerNorm, n2: LayerNorm, qkv: Linear, proj: Linear, ff0: Linear, ff2: Linear, h: usize }

impl Block {
    fn forward(&self, x: &Tensor, mask: &Tensor) -> Result<Tensor> {
        let (b, t, c) = x.dims3()?; let hd = c / self.h;
        let qkv = self.qkv.forward(&self.n1.forward(x)?)?.reshape((b, t, 3, self.h, hd))?.permute((2, 0, 3, 1, 4))?;
        let (q, k, v) = (qkv.i(0)?.contiguous()?, qkv.i(1)?.contiguous()?, qkv.i(2)?.contiguous()?);
        let att = (q.matmul(&k.t()?.contiguous()?)? / (hd as f64).sqrt())?.broadcast_add(mask)?;
        let a = softmax_last_dim(&att)?.matmul(&v)?;                       // (b, h, t, hd)
        let a = a.transpose(1, 2)?.contiguous()?.reshape((b, t, c))?;
        let x = (x + self.proj.forward(&a)?)?;
        let f = self.ff2.forward(&self.ff0.forward(&self.n2.forward(&x)?)?.gelu_erf()?)?;
        Ok((x + f)?)
    }
}

pub struct Gpt { pub cfg: ModelConfig, tok: Embedding, pos: Embedding, blocks: Vec<Block>, norm: LayerNorm, head: Linear, dev: Device }

impl Gpt {
    pub fn load(dir: &Path) -> Result<Self> {
        let cfg: ModelConfig = serde_json::from_slice(&std::fs::read(dir.join("config.json")).context("config.json")?)?;
        if !cfg.tie_embeddings { bail!("tie_embeddings=false non pris en charge"); }
        if cfg.n_heads == 0 || cfg.d_model % cfg.n_heads != 0 { bail!("d_model/n_heads incohérents"); }
        let dev = Device::Cpu;
        let vb = unsafe { VarBuilder::from_mmaped_safetensors(&[dir.join("model.safetensors")], DType::F32, &dev)? };
        let ln = |p: &str| -> Result<LayerNorm> {
            Ok(LayerNorm::new(vb.get(cfg.d_model, &format!("{p}.weight"))?, vb.get(cfg.d_model, &format!("{p}.bias"))?, cfg.layer_norm_eps))
        };
        let lin = |p: &str, o: usize, i: usize| -> Result<Linear> { Ok(Linear::new(vb.get((o, i), &format!("{p}.weight"))?, None)) };
        let tok_w = vb.get((cfg.vocab_size, cfg.d_model), "tok.weight")?;
        let tok = Embedding::new(tok_w.clone(), cfg.d_model);
        let pos = Embedding::new(vb.get((cfg.max_seq_len, cfg.d_model), "pos.weight")?, cfg.d_model);
        let mut blocks = Vec::new();
        for l in 0..cfg.n_layers {
            let p = format!("blocks.{l}");
            blocks.push(Block { n1: ln(&format!("{p}.n1"))?, n2: ln(&format!("{p}.n2"))?, qkv: lin(&format!("{p}.qkv"), 3 * cfg.d_model, cfg.d_model)?,
                proj: lin(&format!("{p}.proj"), cfg.d_model, cfg.d_model)?, ff0: lin(&format!("{p}.ff.0"), cfg.d_ff, cfg.d_model)?,
                ff2: lin(&format!("{p}.ff.2"), cfg.d_model, cfg.d_ff)?, h: cfg.n_heads });
        }
        let norm = ln("norm")?;
        let head = Linear::new(tok_w, None);
        Ok(Self { cfg, tok, pos, blocks, norm, head, dev })
    }

    /// Logits (t, vocab) pour une séquence d'ids (t <= max_seq_len).
    pub fn logits(&self, ids: &[u32]) -> Result<Tensor> {
        let t = ids.len();
        if t == 0 || t > self.cfg.max_seq_len { bail!("longueur de séquence invalide: {t}"); }
        if ids.iter().any(|&i| i as usize >= self.cfg.vocab_size) { bail!("id de token hors vocabulaire"); }
        let idx = Tensor::new(ids, &self.dev)?.unsqueeze(0)?;
        let p = Tensor::arange(0u32, t as u32, &self.dev)?.unsqueeze(0)?;
        let mut x = (self.tok.forward(&idx)? + self.pos.forward(&p)?)?;
        let mask: Vec<f32> = (0..t).flat_map(|i| (0..t).map(move |j| if j > i { f32::NEG_INFINITY } else { 0.0 })).collect();
        let mask = Tensor::from_vec(mask, (t, t), &self.dev)?;
        for b in &self.blocks { x = b.forward(&x, &mask)?; }
        Ok(self.head.forward(&self.norm.forward(&x)?)?.squeeze(0)?)
    }

    /// Prochain token glouton (argmax) — déterministe.
    pub fn next_greedy(&self, ids: &[u32]) -> Result<u32> {
        let w = &ids[ids.len().saturating_sub(self.cfg.max_seq_len)..];
        let lg = self.logits(w)?;
        Ok(lg.i(w.len() - 1)?.argmax(D::Minus1)?.to_scalar::<u32>()?)
    }
}
