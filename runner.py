# runner.py
import argparse
import signal
import sys
import time
from typing import Optional, Tuple

import numpy as np

from capture import Capture


def _parse_roi(s: Optional[str]) -> Optional[Tuple[int, int, int, int]]:
    if not s:
        return None
    parts = s.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("roi must be 'left,top,width,height'")
    return tuple(int(x.strip()) for x in parts)


def main():
    p = argparse.ArgumentParser(description="Run screen capture")
    p.add_argument("--monitor", type=int, default=0, help="0=all, 1..=specific monitor")
    p.add_argument(
        "--roi",
        type=_parse_roi,
        default=None,
        help="left,top,width,height (overrides --monitor)",
    )
    p.add_argument("--fps", type=int, default=30, help="target FPS")
    p.add_argument("--fmt", type=str, default="BGRA", choices=["BGRA", "BGR", "RGB", "GRAY"])
    p.add_argument("--preview", action="store_true", help="show a live preview window")
    args = p.parse_args()

    cap = Capture(
        monitor=args.monitor,
        roi=args.roi,
        pixel_format=args.fmt,
        target_fps=args.fps,
        show_preview=args.preview,
    )

    # Clean shutdown on Ctrl+C
    def _sigint(_sig, _frm):
        cap.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, _sigint)

    print(f"backend=mss monitor={args.monitor} roi={args.roi} fmt={args.fmt}")
    cap.start()

    try:
        last_ts = 0.0
        while True:
            frame, ts = cap.latest()
            if frame is None or ts == last_ts:
                time.sleep(0.005)
                continue
            last_ts = ts

            # Example consumer: compute simple checksum to verify new frames without GUI
            if isinstance(frame, np.ndarray):
                checksum = int(frame.ravel()[::4096].sum()) & 0xFFFFFFFF
                print(f"time={ts:.3f} size={tuple(frame.shape)} sum={checksum}")
            # Insert your downstream processing here

            # Avoid spamming by slowing the main loop slightly
            time.sleep(0.01)
    finally:
        cap.stop()


if __name__ == "__main__":
    main()
