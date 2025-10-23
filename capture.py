# capture.py
import threading
import time
from typing import Optional, Tuple, Dict, Union

import numpy as np

try:
    import cv2  # optional, only needed for display or some color conversions
except Exception:
    cv2 = None

try:
    import mss
except Exception as e:
    raise ImportError("mss is required: pip install mss") from e


ROIType = Union[Tuple[int, int, int, int], Dict[str, int]]


class Capture:
    """
    Threaded screen capture using MSS on Windows/Linux/macOS.

    Key points:
      - Create the MSS() instance inside the worker thread, not the main thread.
      - monitors[0] is the virtual full desktop. monitors[1..] are physical displays.
      - ROI must be a dict with left/top/width/height or a 4-tuple (l, t, w, h).
    """

    def __init__(
        self,
        monitor: int = 0,
        roi: Optional[ROIType] = None,
        pixel_format: str = "BGRA",
        target_fps: int = 30,
        show_preview: bool = False,
    ):
        self.monitor = int(monitor)
        self.roi = self._normalize_roi(roi) if roi is not None else None
        self.pixel_format = pixel_format.upper()
        self.target_fps = int(target_fps)
        self.show_preview = bool(show_preview)

        if self.pixel_format not in {"BGRA", "BGR", "RGB", "GRAY"}:
            raise ValueError("pixel_format must be one of: BGRA, BGR, RGB, GRAY")

        if self.show_preview and cv2 is None:
            raise RuntimeError("OpenCV (cv2) is required for preview. pip install opencv-python")

        self._running = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

        self._frame: Optional[np.ndarray] = None
        self._timestamp: float = 0.0
        self._frame_counter = 0

    # ---------- public API ----------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._running.set()
        self._thread = threading.Thread(target=self._loop, name="CaptureLoop", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running.clear()
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None

    def latest(self) -> Tuple[Optional[np.ndarray], float]:
        """Return the most recent frame and its timestamp. Frame is a NumPy array."""
        with self._lock:
            if self._frame is None:
                return None, 0.0
            # hand out a reference; caller should not mutate in-place
            return self._frame, self._timestamp

    # ---------- internals ----------

    @staticmethod
    def _normalize_roi(roi: ROIType) -> Dict[str, int]:
        if isinstance(roi, dict):
            for k in ("left", "top", "width", "height"):
                if k not in roi:
                    raise ValueError(f"roi dict missing key: {k}")
            return {"left": int(roi["left"]), "top": int(roi["top"]),
                    "width": int(roi["width"]), "height": int(roi["height"])}
        if isinstance(roi, tuple) and len(roi) == 4:
            l, t, w, h = map(int, roi)
            return {"left": l, "top": t, "width": w, "height": h}
        raise ValueError("roi must be dict with left/top/width/height or 4-tuple (l,t,w,h)")

    @staticmethod
    def _bgra_to(fmt: str, arr: np.ndarray) -> np.ndarray:
        # MSS returns BGRA. Convert on demand without requiring cv2 except when GRAY weights are needed.
        if fmt == "BGRA":
            return arr
        if fmt == "BGR":
            return arr[..., :3]
        if fmt == "RGB":
            bgr = arr[..., :3]
            return bgr[..., ::-1]
        if fmt == "GRAY":
            # luminance approximation without cv2
            b = arr[..., 0].astype(np.float32)
            g = arr[..., 1].astype(np.float32)
            r = arr[..., 2].astype(np.float32)
            y = (0.114 * b + 0.587 * g + 0.299 * r).astype(np.uint8)
            return y
        return arr

    def _loop(self) -> None:
        # Create MSS inside the thread. Windows handles are thread-local. See linked issue.
        # Also ensure region selection is resolved against this instance's monitors list.
        try:
            with mss.mss() as sct:
                region = self._resolve_region(sct)
                frame_interval = 1.0 / max(self.target_fps, 1)

                last_print = time.perf_counter()
                frames_this_sec = 0

                if self.show_preview:
                    win_name = "Capture"
                    cv2.namedWindow(win_name, cv2.WINDOW_NORMAL)

                while self._running.is_set():
                    t0 = time.perf_counter()
                    shot = sct.grab(region)  # BGRA
                    arr = np.asarray(shot)  # HxWx4 BGRA uint8
                    frame = self._bgra_to(self.pixel_format, arr)

                    with self._lock:
                        self._frame = frame
                        self._timestamp = t0
                        self._frame_counter += 1

                    if self.show_preview:
                        disp = frame
                        if self.pixel_format == "GRAY":
                            cv2.imshow(win_name, disp)
                        elif self.pixel_format == "RGB":
                            # cv2 expects BGR for color display
                            cv2.imshow(win_name, disp[..., ::-1])
                        else:
                            cv2.imshow(win_name, disp)
                        if cv2.waitKey(1) & 0xFF == 27:  # ESC to quit preview
                            self._running.clear()
                            break

                    # basic FPS throttle
                    dt = time.perf_counter() - t0
                    sleep_time = frame_interval - dt
                    if sleep_time > 0:
                        time.sleep(sleep_time)

                    frames_this_sec += 1
                    now = time.perf_counter()
                    if now - last_print >= 1.0:
                        # print live FPS for diagnostics
                        print(f"fps={frames_this_sec}")
                        frames_this_sec = 0
                        last_print = now
        finally:
            if self.show_preview and cv2 is not None:
                try:
                    cv2.destroyAllWindows()
                except Exception:
                    pass
            self._running.clear()

    def _resolve_region(self, sct: "mss.base.MSSBase") -> Dict[str, int]:
        if self.roi is not None:
            return self.roi
        monitors = sct.monitors  # list, monitors[0] is the virtual screen
        if not monitors:
            raise RuntimeError("No monitors reported by MSS.")
        idx = self.monitor
        if idx < 0 or idx >= len(monitors):
            raise ValueError(f"monitor index out of range. got {idx}, have 0..{len(monitors)-1}")
        return monitors[idx]
