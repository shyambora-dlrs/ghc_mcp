import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

_spec = importlib.util.spec_from_file_location("synthetic_pdfs", ROOT / "tests/fixtures/synthetic/generate_synthetic_pdfs.py")
synthetic = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(synthetic)  # type: ignore[union-attr]
VECTORS = ROOT / "packages/shared-types/test-vectors/normalization.json"
