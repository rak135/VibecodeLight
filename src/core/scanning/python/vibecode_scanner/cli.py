import argparse
import json
from pathlib import Path
from typing import Optional

try:
    import typer  # type: ignore
except ModuleNotFoundError:
    typer = None


def main(
    repo: Optional[Path] = None,
    task: Optional[str] = None,
    scanner_config: Optional[Path] = None,
    out: Optional[Path] = None,
    json_output: bool = False,
):
    """Run the VibecodeLight deterministic repository scanner."""
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
        scan_manifest = {
            "scanner_version": "0.1.0",
            "status": "skeleton",
            "repo": str(repo) if repo else None,
            "task": task,
            "scanner_config": str(scanner_config) if scanner_config else None,
        }
        (out / "scan_manifest.json").write_text(json.dumps(scan_manifest, indent=2))

    if json_output:
        result = {"status": "ok", "scanner_version": "0.1.0"}
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
    def app() -> None:
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
