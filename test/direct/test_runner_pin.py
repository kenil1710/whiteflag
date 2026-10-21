"""The files Direct Mode runs differ from build/ only in the runner hash."""
from conftest import GATE, PUBLISHED_RUNNER, REGISTRY, ROOT, STUDIO_RUNNER


def test_only_the_runner_line_differs():
    for name, path in (("WhiteFlagRegistry", REGISTRY), ("SafeHarborGate", GATE)):
        built = (ROOT / "build" / (name + ".py")).read_text()
        ran = open(path).read()
        assert ran == built.replace(STUDIO_RUNNER, PUBLISHED_RUNNER)
        assert [a for a, b in zip(built.splitlines(), ran.splitlines()) if a != b] == [
            '# { "Depends": "py-genlayer:%s" }' % STUDIO_RUNNER]
