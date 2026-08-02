#!/usr/bin/env python3
"""Small JSON bridge around the official PandaAI panda_data SDK."""

import importlib.util
import json
import os
import sys
import tempfile


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, allow_nan=False, default=str))


def normalize_result(result, max_rows):
    row_count = None
    truncated = False

    if hasattr(result, "to_json") and hasattr(result, "head"):
        try:
            row_count = len(result)
            truncated = row_count > max_rows
            limited = result.head(max_rows)
            data = json.loads(limited.to_json(orient="records", date_format="iso", force_ascii=False))
            return data, row_count, truncated
        except (TypeError, ValueError):
            pass

    if isinstance(result, (list, tuple)):
        row_count = len(result)
        truncated = row_count > max_rows
        return list(result[:max_rows]), row_count, truncated

    if isinstance(result, dict):
        return result, len(result), False

    if hasattr(result, "to_dict"):
        try:
            return result.to_dict(), None, False
        except TypeError:
            pass

    return result, None, False


def main():
    if "--probe" in sys.argv:
        emit({"installed": importlib.util.find_spec("panda_data") is not None})
        return 0

    username = os.environ.get("PANDA_DATA_USERNAME", "").strip()
    password = os.environ.get("PANDA_DATA_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("PANDA_DATA_USERNAME 或 PANDA_DATA_PASSWORD 未配置")

    request = json.loads(sys.stdin.read() or "{}")
    method = str(request.get("method", "")).strip()
    params = request.get("params") or {}
    allowed = {item.strip() for item in os.environ.get("PANDA_DATA_ALLOWED_METHODS", "").split(",") if item.strip()}
    if method not in allowed:
        raise ValueError(f"Panda Data 方法不在白名单：{method}")
    if not isinstance(params, dict):
        raise TypeError("params 必须是 JSON 对象")

    with tempfile.TemporaryDirectory(prefix="panda-data-auth-") as auth_dir:
        import panda_data
        import panda_data.auth_manager as auth_manager

        if not hasattr(auth_manager, "_user_json_dir"):
            raise RuntimeError("当前 panda_data SDK 不支持隔离认证文件")
        auth_manager._user_json_dir = auth_dir

        base_url = os.environ.get("PANDA_DATA_BASE_URL", "http://pandadata.pandaaiquant.com").strip()
        panda_data.init_token(username=username, password=password, base_url=base_url)
        function = getattr(panda_data, method, None)
        if not callable(function):
            raise AttributeError(f"当前 panda_data SDK 不支持方法：{method}")

        result = function(**params)
        max_rows = max(1, int(os.environ.get("PANDA_DATA_MAX_ROWS", "500")))
        data, row_count, truncated = normalize_result(result, max_rows)
    emit({
        "provider": "pandaai",
        "method": method,
        "rowCount": row_count,
        "truncated": truncated,
        "data": data,
    })
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit({"error": f"{type(error).__name__}: {error}"})
        raise SystemExit(1)
