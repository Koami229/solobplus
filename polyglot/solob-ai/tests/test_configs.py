from solob_ai.model.config import Config
from solob_ai.model.gpt import GPT
def test_configs_load_same_code():
    c, g = Config.load("configs/cpu.yaml"), Config.load("configs/gpu-small.yaml")
    assert c.train.device == "cpu" and g.train.device == "cuda"
    n = GPT(c.model).n_params(); assert 1_000_000 <= n <= 5_000_000, n
