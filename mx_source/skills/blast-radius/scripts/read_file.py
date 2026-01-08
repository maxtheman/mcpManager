#!/usr/bin/env python3
import argparse
import pathlib
import sys


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read a file and print a small preview to stdout (for skill demo/testing)."
    )
    parser.add_argument("path", help="Path to the file to read")
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=16_384,
        help="Maximum bytes to read (default: 16384)",
    )
    args = parser.parse_args()

    file_path = pathlib.Path(args.path).expanduser()
    if not file_path.exists():
        sys.stderr.write(f"error: file not found: {file_path}\n")
        return 2
    if not file_path.is_file():
        sys.stderr.write(f"error: not a file: {file_path}\n")
        return 2

    data = file_path.read_bytes()[: max(0, args.max_bytes)]
    text = data.decode("utf-8", errors="replace")
    sys.stdout.write(text)
    if len(data) >= args.max_bytes:
        sys.stdout.write("\n\n[truncated]\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
