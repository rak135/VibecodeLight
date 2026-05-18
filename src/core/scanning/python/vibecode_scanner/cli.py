import argparse
import json
from pathlib import Path
from typing import Optional

try:
    import typer  # type: ignore
except ModuleNotFoundError:
    typer = None

from .scan.base_scan import run_base_scan, SCANNER_VERSION


def main(
    repo: Optional[Path] = None,
    task: Optional[str] = None,
    scanner_config: Optional[Path] = None,
    out: Optional[Path] = None,
    json_output: bool = False,
):
    """Run the VibecodeLight deterministic repository scanner."""
    repo_root = repo or Path.cwd()
    task_str = task or ""
    run_id: Optional[str] = None

    # Load run_id from scanner_config if provided
    if scanner_config is not None and scanner_config.exists():
        try:
            config_data = json.loads(scanner_config.read_text(encoding="utf-8"))
            run_id = config_data.get("run_id")
            if not task_str:
                task_str = config_data.get("task", "")
            if repo is None:
                repo_root = Path(config_data.get("repo_root", str(repo_root)))
        except (json.JSONDecodeError, OSError):
            pass

    if out is not None:
        summary = run_base_scan(
            repo_root=repo_root,
            task=task_str,
            out_dir=out,
            run_id=run_id,
            scanner_config_path=scanner_config,
        )
        if json_output:
            result = {"status": "ok", "scanner_version": SCANNER_VERSION, "run_id": run_id, "artifacts": summary.get("artifacts", {})}
            print(json.dumps(result))
    else:
        if json_output:
            result = {"status": "ok", "scanner_version": SCANNER_VERSION}
            print(json.dumps(result))


if typer is not None:
    app = typer.Typer(name="vibecode-scanner", help="VibecodeLight deterministic repository scanner")

    @app.command()
    def main_command(
        repo: Optional[Path] = typer.Option(None, "--repo", help="Repository root path"),
        task: Optional[str] = typer.Option(None, "--task", help="Task description"),
        scanner_config: Optional[Path] = typer.Option(
            None, "--scanner-config", help="Path to scanner_config.json"
        ),
        out: Optional[Path] = typer.Option(None, "--out", help="Output directory for scan artifacts"),
        json_output: bool = typer.Option(False, "--json", help="Output JSON summary to stdout"),
    ):
        main(repo=repo, task=task, scanner_config=scanner_config, out=out, json_output=json_output)
else:
    def app() -> None:  # type: ignore[misc]
        parser = argparse.ArgumentParser(prog="vibecode-scanner", description="VibecodeLight deterministic repository scanner")
        parser.add_argument("--repo", type=Path, default=None, help="Repository root path")
        parser.add_argument("--task", type=str, default=None, help="Task description")
        parser.add_argument("--scanner-config", type=Path, default=None, help="Path to scanner_config.json")
        parser.add_argument("--out", type=Path, default=None, help="Output directory for scan artifacts")
        parser.add_argument("--json", dest="json_output", action="store_true", help="Output JSON summary to stdout")
        args = parser.parse_args()
        main(repo=args.repo, task=args.task, scanner_config=args.scanner_config, out=args.out, json_output=args.json_output)


if __name__ == "__main__":
    app()
