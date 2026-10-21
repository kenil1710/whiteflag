#!/bin/sh
# GenLayer Direct Mode (genlayer-test): the deployed build files inside the
# GenLayer Python SDK, validators re-run against changed RPC answers.
#   python -m venv .venv && .venv/bin/pip install "genlayer-test @ git+https://github.com/genlayerlabs/genlayer-testing-suite@343e3a358f9e235a93b49c60721ce7676585ff07"
cd "$(dirname "$0")/.." && GENVM_VERSION=${GENVM_VERSION:-v0.3.0-rc7} ${PYTHON:-.venv/bin/python} -m pytest test/direct -q "$@"
