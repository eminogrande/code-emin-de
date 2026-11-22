import json
import shlex
import tempfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_SOURCE_COMMIT = "77addff168d4201f3c7f3d60d3abbd9167f8d09a"
_NODE_VERSION = "22.20.0"
_NODE_CHECKSUMS = {
    "x64": "00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc",
    "arm64": "06907b9c088ce62305bc1530e5c1ae1510245114645768f7750c349c5b6fe667",
}
_CLONE_DIR = "/opt/emin-swarm"
_DRIVER_REMOTE = f"{_CLONE_DIR}/harbor-driver.mjs"
_DRIVER_TMP = "/tmp/emin-harbor-driver.mjs"
_SOURCE_ARCHIVE = "/tmp/emin-harbor-source.tar"
_INSTRUCTION_REMOTE = "/tmp/emin-harbor-instruction.txt"
_MODEL_ENV_REMOTE = "/tmp/emin-harbor-model.env"
_OUTCOME_MARKER = "EMIN_SWARM_OUTCOME:"
_MODEL_ENV_NAMES = (
    "LLMGATEWAY_API_KEY",
    "ALLMODELS_API_KEY",
    "ROUTER_PAYMENTREQUIRED_API_KEY",
    "LOCAL_LLAMA_URL",
    "LOCAL_LLAMA_MODEL",
    "LOCAL_LLAMA_API_KEY",
    "LOCAL_LLAMA_CTX",
    *tuple(
        f"{prefix}_{role}"
        for prefix in ("MODEL", "PROVIDER")
        for role in (
            "LEAD",
            "PLANNER",
            "CODER",
            "CODER_FAST",
            "REVIEWER",
            "REVIEWER_DEEP",
            "SUPPORT",
            "SOCIAL",
            "WATCHER",
            "BTW",
        )
    ),
)


class EminSwarmAgent(BaseInstalledAgent):
    DEFAULT_SETUP_TIMEOUT_SEC = 1200

    def __init__(
        self,
        *args,
        timeout_sec: int = 3600,
        setup_timeout_sec: int = 1200,
        lead_max_turns: int = 64,
        **kwargs,
    ):
        self._timeout_sec = self._positive_seconds(timeout_sec, "timeout_sec", minimum=60)
        self._setup_timeout_sec = self._positive_seconds(
            setup_timeout_sec, "setup_timeout_sec", minimum=60
        )
        self._lead_max_turns = self._positive_seconds(lead_max_turns, "lead_max_turns", minimum=16)
        super().__init__(*args, **kwargs)

    @staticmethod
    def _positive_seconds(value, name: str, minimum: int) -> int:
        if isinstance(value, bool):
            raise ValueError(f"{name} must be an integer >= {minimum}")
        try:
            seconds = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be an integer >= {minimum}") from exc
        if seconds < minimum:
            raise ValueError(f"{name} must be an integer >= {minimum}")
        return seconds

    @staticmethod
    def name() -> str:
        return "emin-swarm"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment,
            ("bash", "curl", "ca_certificates", "git", "python3", "tar", "xz"),
        )

        node_dir = f"/opt/node-v{_NODE_VERSION}-linux"
        archive_base = f"/tmp/node-v{_NODE_VERSION}-linux"
        node_install = f"""
set -euo pipefail
if ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
  echo 'Emin Swarm Node installation requires a glibc-based Linux task image' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) checksum="{_NODE_CHECKSUMS['x64']}"; suffix="x64" ;;
  aarch64|arm64) checksum="{_NODE_CHECKSUMS['arm64']}"; suffix="arm64" ;;
  *) echo "Unsupported architecture for Node {_NODE_VERSION}: $(uname -m)" >&2; exit 1 ;;
esac
node_dir="{node_dir}-$suffix"
archive="{archive_base}-$suffix.tar.xz"
curl -fsSL --retry 3 "https://nodejs.org/dist/v{_NODE_VERSION}/node-v{_NODE_VERSION}-linux-$suffix.tar.xz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
tar -xJf "$archive" -C /opt
ln -sf "$node_dir/bin/node" /usr/local/bin/node
ln -sf "$node_dir/bin/npm" /usr/local/bin/npm
ln -sf "$node_dir/bin/npx" /usr/local/bin/npx
node -e 'if (process.version !== "v{_NODE_VERSION}") throw new Error(`Unexpected Node version: ${{process.version}}`)'
""".strip()
        await self.exec_as_root(
            environment,
            command=node_install,
            timeout_sec=self._setup_timeout_sec,
        )

    async def configure(self, environment: BaseEnvironment) -> None:
        source_archive = Path(__file__).with_name("source.tar")
        driver_source = Path(__file__).with_name("driver.mjs")
        await environment.upload_file(source_archive, _SOURCE_ARCHIVE)
        await environment.upload_file(driver_source, _DRIVER_TMP)
        command = f"""
set -euo pipefail
mkdir -p {shlex.quote(_CLONE_DIR)}
tar -xf {shlex.quote(_SOURCE_ARCHIVE)} -C {shlex.quote(_CLONE_DIR)}
printf '%s\n' {shlex.quote(_SOURCE_COMMIT)} > {shlex.quote(_CLONE_DIR + "/.harbor-source-commit")}
test "$(cat {shlex.quote(_CLONE_DIR + "/.harbor-source-commit")})" = {shlex.quote(_SOURCE_COMMIT)}
cp {shlex.quote(_DRIVER_TMP)} {shlex.quote(_DRIVER_REMOTE)}
chmod 0644 {shlex.quote(_DRIVER_REMOTE)}
npm --prefix {shlex.quote(_CLONE_DIR)} ci --omit=dev --ignore-scripts --no-audit --no-fund
""".strip()
        await self.exec_as_root(
            environment,
            command=command,
            timeout_sec=self._setup_timeout_sec,
        )

    def _model_environment(self) -> dict[str, str]:
        env = {
            name: value
            for name in _MODEL_ENV_NAMES
            if (value := self._get_env(name)) is not None
        }
        if not any(
            name in env
            for name in (
                "LLMGATEWAY_API_KEY",
                "ALLMODELS_API_KEY",
                "LOCAL_LLAMA_URL",
            )
        ):
            raise RuntimeError(
                "Emin Swarm requires LLMGATEWAY_API_KEY or ALLMODELS_API_KEY "
                "for the baseline roster (or an explicit local provider configuration)"
            )
        return env

    def _record_outcome(self, stdout: str, context: AgentContext) -> None:
        lines = [line for line in stdout.splitlines() if line.startswith(_OUTCOME_MARKER)]
        if not lines:
            raise RuntimeError("Emin Swarm driver exited successfully without a JSON outcome")
        outcome = json.loads(lines[-1][len(_OUTCOME_MARKER) :])
        (self.logs_dir / "emin-swarm-outcome.json").write_text(
            json.dumps(outcome, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        usage = outcome.get("usage") or {}
        context.n_input_tokens = int(usage.get("inputTokens") or 0)
        context.n_output_tokens = int(usage.get("outputTokens") or 0)
        context.n_cache_tokens = int(usage.get("cacheReadTokens") or 0)
        context.cost_usd = float(usage.get("costUsd") or 0)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model_env = self._model_environment()
        with tempfile.TemporaryDirectory(prefix="harbor-emin-instruction-") as temp_dir:
            local_instruction = Path(temp_dir) / "instruction.txt"
            local_instruction.write_text(instruction, encoding="utf-8")
            local_model_env = Path(temp_dir) / "model.env"
            local_model_env.write_text(
                "".join(f"{name}={shlex.quote(value)}\n" for name, value in model_env.items()),
                encoding="utf-8",
            )
            local_model_env.chmod(0o600)
            await environment.upload_file(local_instruction, _INSTRUCTION_REMOTE)
            await environment.upload_file(local_model_env, _MODEL_ENV_REMOTE)

        identity = await environment.exec(command="id -un", timeout_sec=self._setup_timeout_sec)
        agent_user = (identity.stdout or "").strip() or "root"
        await self.exec_as_root(
            environment,
            command=(
                f"chown {shlex.quote(agent_user)}:{shlex.quote(agent_user)} {shlex.quote(_MODEL_ENV_REMOTE)} && "
                f"chmod 0600 {shlex.quote(_MODEL_ENV_REMOTE)} && "
                f"chmod 0644 {shlex.quote(_INSTRUCTION_REMOTE)}"
            ),
            timeout_sec=self._setup_timeout_sec,
        )
        result = await environment.exec(
            command=(
                f"set -a; . {shlex.quote(_MODEL_ENV_REMOTE)}; set +a; "
                f"exec /usr/local/bin/node {shlex.quote(_DRIVER_REMOTE)} "
                f"{shlex.quote(_INSTRUCTION_REMOTE)}"
            ),
            env={
                "SWARM_SELF_REPO": "/nonexistent-harbor",
                "EMIN_SWARM_TIMEOUT_SEC": str(self._timeout_sec),
                "EMIN_SWARM_LEAD_MAX_TURNS": str(self._lead_max_turns),
            },
            timeout_sec=self._timeout_sec + 30,
        )
        if _OUTCOME_MARKER in (result.stdout or ""):
            self._record_outcome(result.stdout or "", context)
        if result.return_code != 0:
            lines = (result.stderr or result.stdout or "").strip().splitlines()
            detail = lines[-1] if lines else "driver failed"
            raise RuntimeError(f"Emin Swarm driver exited with code {result.return_code}: {detail}")
        if _OUTCOME_MARKER not in (result.stdout or ""):
            raise RuntimeError("Emin Swarm driver exited successfully without a JSON outcome")
