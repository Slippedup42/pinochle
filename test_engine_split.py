"""
Issue #249 (epic #214): the strategy half of the Python engine moved to
`pinochle_ai.py`, and `pinochle_engine.py` re-exports it.

These pin the shape of that split rather than any behaviour - the behaviour
is pinned by every other test in the suite, none of which changed an import:

  - Every name pinochle_ai defines is re-exported, as the same object. A new
    function added to pinochle_ai without a line in `_AI_NAMES` fails here
    instead of as an ImportError in whichever caller first reaches for it
    through the shim.
  - The only load-time edge is strategy -> rules. Either module can be
    imported first, in a fresh interpreter, and importing the rules module
    does not load the strategy module.
  - A player pickled through the shim comes back as the same class (the
    `human_play.py` resume path pickles a whole round).
"""

import ast
import os
import pickle
import subprocess
import sys

import pinochle_ai
import pinochle_engine


REPO_ROOT = os.path.dirname(os.path.abspath(__file__))


def _defined_in(module):
    path = os.path.join(REPO_ROOT, f"{module.__name__}.py")
    tree = ast.parse(open(path, encoding="utf-8").read())
    names = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return names


def _fresh(code):
    return subprocess.run(
        [sys.executable, "-c", code], cwd=REPO_ROOT,
        capture_output=True, text=True, check=False)


def test_every_strategy_name_is_re_exported_as_the_same_object():
    defined = _defined_in(pinochle_ai)
    assert defined == pinochle_engine._AI_NAMES
    for name in defined:
        assert getattr(pinochle_engine, name) is getattr(pinochle_ai, name), name


def test_no_name_is_defined_on_both_sides():
    assert not (_defined_in(pinochle_ai) & _defined_in(pinochle_engine))


def test_strategy_module_can_be_imported_first():
    result = _fresh("import pinochle_ai, pinochle_engine; "
                    "assert pinochle_engine.Player is pinochle_ai.Player")
    assert result.returncode == 0, result.stderr


def test_rules_module_does_not_load_the_strategy_module():
    result = _fresh("import sys, pinochle_engine; "
                    "assert 'pinochle_ai' not in sys.modules; "
                    "from pinochle_engine import Player; "
                    "assert 'pinochle_ai' in sys.modules")
    assert result.returncode == 0, result.stderr


def test_unknown_names_still_raise_attribute_error():
    assert not hasattr(pinochle_engine, "no_such_name")


def test_a_player_pickles_through_the_shim():
    player = pinochle_engine.Player("me", None)
    copy = pickle.loads(pickle.dumps(player))
    assert type(copy) is pinochle_engine.Player
