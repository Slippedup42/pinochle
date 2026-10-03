"""
Epic #214: the Python engine is two real modules and a shim.

  - `pinochle_rules_engine.py` - the rules and the bid-valuation chain
    (#250). Python-authoritative.
  - `pinochle_ai.py` - the strategy layer (#249). Not authoritative; since
    #213 TypeScript owns the measured strategy constants.
  - `pinochle_engine.py` - a re-export shim over the two, defining nothing.

These pin the shape of that split rather than any behaviour - the behaviour
is pinned by every other test in the suite, which still imports through the
shim:

  - The shim defines nothing, and re-exports every name either real module
    defines, as the same object. A function added to either module without a
    line in the shim fails here instead of as an ImportError in whichever
    caller first reaches for it through `pinochle_engine`.
  - Nothing is defined in both real modules.
  - The only load-time edge is strategy -> rules. Either real module can be
    imported first in a fresh interpreter, and importing the rules module
    does not load the strategy module.
  - The file boundary is #213's authority line: every constant
    `test_ported_constants.py` calls Python-authoritative lives in the rules
    module, and every TypeScript-owned or shared one in the AI module.
  - Objects pickle under their defining module, and a pickle written before
    the split (`pinochle_engine.X`) still loads (the `human_play.py` resume
    path pickles a whole round).
"""

import ast
import os
import pickle
import subprocess
import sys

import pinochle_ai
import pinochle_engine
import pinochle_rules_engine
import test_ported_constants


REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
REAL_MODULES = (pinochle_rules_engine, pinochle_ai)


def _tree(module):
    path = os.path.join(REPO_ROOT, f"{module.__name__}.py")
    with open(path, encoding="utf-8") as f:
        return ast.parse(f.read())


def _defined_in(module):
    names = set()
    for node in _tree(module).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def _fresh(code):
    return subprocess.run(
        [sys.executable, "-c", code], cwd=REPO_ROOT,
        capture_output=True, text=True, check=False)


def test_the_shim_defines_nothing():
    """Imports, `__all__`, the module docstring and the `__main__` demo -
    nothing that binds a name of its own."""
    body = _tree(pinochle_engine).body
    for i, node in enumerate(body):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        if i == 0 and isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            continue
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == "__all__"):
            continue
        if isinstance(node, ast.If) and ast.unparse(node.test) == "__name__ == '__main__'":
            continue
        raise AssertionError(
            f"pinochle_engine.py line {node.lineno} is not an import, `__all__` or "
            f"the __main__ demo: {ast.unparse(node)[:80]!r}. Define it in "
            f"pinochle_rules_engine.py or pinochle_ai.py and re-export it.")


def test_the_shim_imports_only_from_the_two_real_modules():
    sources = {node.module for node in _tree(pinochle_engine).body
               if isinstance(node, ast.ImportFrom)}
    assert sources == {"pinochle_rules_engine", "pinochle_ai"}
    assert not [n for n in _tree(pinochle_engine).body if isinstance(n, ast.Import)]


def test_every_name_is_re_exported_as_the_same_object():
    for module in REAL_MODULES:
        for name in _defined_in(module):
            assert getattr(pinochle_engine, name) is getattr(module, name), \
                f"{module.__name__}.{name}"


def test_all_lists_exactly_what_the_two_modules_define():
    expected = _defined_in(pinochle_rules_engine) | _defined_in(pinochle_ai)
    assert len(pinochle_engine.__all__) == len(set(pinochle_engine.__all__))
    assert set(pinochle_engine.__all__) == expected


def test_no_name_is_defined_in_both_real_modules():
    assert not (_defined_in(pinochle_ai) & _defined_in(pinochle_rules_engine))


def test_unknown_names_still_raise_attribute_error():
    assert not hasattr(pinochle_engine, "no_such_name")


def test_the_strategy_module_can_be_imported_first():
    result = _fresh("import pinochle_ai, pinochle_rules_engine, pinochle_engine; "
                    "assert pinochle_engine.Player is pinochle_ai.Player; "
                    "assert pinochle_ai.Suit is pinochle_rules_engine.Suit")
    assert result.returncode == 0, result.stderr


def test_the_rules_module_does_not_load_the_strategy_module():
    result = _fresh("import sys, pinochle_rules_engine; "
                    "assert 'pinochle_ai' not in sys.modules; "
                    "assert 'pinochle_engine' not in sys.modules; "
                    "pinochle_rules_engine.Game(['N', 'E', 'S', 'W']); "
                    "assert 'pinochle_ai' in sys.modules")
    assert result.returncode == 0, result.stderr


def test_the_shim_can_be_imported_first():
    result = _fresh("import pinochle_engine, pinochle_ai, pinochle_rules_engine; "
                    "assert pinochle_engine.Card is pinochle_rules_engine.Card")
    assert result.returncode == 0, result.stderr


def test_the_file_boundary_is_the_authority_line():
    """#250's deliverable: a reader can tell which authority a Python
    constant carries from the filename alone."""
    rules, ai = _defined_in(pinochle_rules_engine), _defined_in(pinochle_ai)
    misplaced = []
    for ts_file, ts_name, py_name, owner in test_ported_constants.PAIRS:
        home = rules if owner == test_ported_constants.PYTHON else ai
        if py_name not in home:
            misplaced.append((py_name, owner))
    assert not misplaced, (
        f"{misplaced}: PYTHON-authoritative constants belong in "
        f"pinochle_rules_engine.py, TYPESCRIPT and SHARED ones in pinochle_ai.py.")


def test_objects_pickle_under_their_defining_module():
    player = pinochle_engine.Player("me", None)
    card = pinochle_engine.Card(pinochle_engine.Suit.HEARTS, "A", 1)
    assert type(pickle.loads(pickle.dumps(player))) is pinochle_ai.Player
    copy = pickle.loads(pickle.dumps(card))
    assert type(copy) is pinochle_rules_engine.Card
    assert copy.suit is pinochle_rules_engine.Suit.HEARTS


def test_a_pickle_written_before_the_split_still_loads():
    """State saved before #249/#250 names every class `pinochle_engine.X`.
    Protocol 0 spells the module out as text, so it can be rewritten into
    exactly what an old save file contains."""
    card = pinochle_rules_engine.Card(pinochle_rules_engine.Suit.SPADES, "10", 2)
    player = pinochle_ai.Player("me", None)
    for obj, module in ((card, b"pinochle_rules_engine"), (player, b"pinochle_ai")):
        data = pickle.dumps(obj, protocol=0)
        assert module + b"\n" in data
        old = data.replace(module + b"\n", b"pinochle_engine\n")
        assert type(pickle.loads(old)) is type(obj)
