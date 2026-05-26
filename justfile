_default:
    @just --list

# Install all tooling and dependencies (first-time setup)
setup:
    mise install
    uv sync --all-extras
    pnpm install
    pre-commit install

# Run all linters
lint:
    uv run ruff check .
    pnpm exec biome check .

# Auto-format all code
format:
    uv run ruff format .
    uv run ruff check --fix .
    pnpm exec biome format --write .

# Run all type checkers
typecheck:
    uv run pyright
    pnpm -r exec tsc --noEmit

# Run all tests
test:
    uv run pytest
    pnpm -r exec vitest run

# Run lint + typecheck + test (pre-PR check)
check: lint typecheck test
