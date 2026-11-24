"""The matching rule in scripts/specs_epa_import.py. Run: PYTHONPATH=. python3 tests/test_specs_epa.py"""
from scripts.specs_epa_import import match


def row(model, hp, drive=""):
    return {"model": model, "hp": hp, "drive": drive}


def test_match():
    assert match([row("SILVERADO 4WD", 355)], "Silverado 1500") == ("ok", 355)                 # class suffix, drive word dropped
    assert match([row("SILVERADO 2WD", 355), row("SILVERADO 4WD", 354)], "silverado") == ("ok", 355)  # within 2%
    assert match([row("ENCORE GX AWD", 155)], "Encore") == ("none", None)                       # a different model line
    assert match([row("Accord", 192), row("Accord", 252)], "accord") == ("ambiguous", None)     # two tunes
    assert match([row("Accord", 192, "fwd"), row("Accord", 252, "awd")], "accord", "FWD") == ("ok", 192)  # drive settles it
    assert match([row("Accord", 192, "fwd"), row("Accord", 252, "awd")], "accord", "") == ("ambiguous", None)
    assert match([], "accord") == ("none", None)
    assert match([row("X", 100)], "") == ("none", None)


if __name__ == "__main__":
    test_match()
    print("ok")
