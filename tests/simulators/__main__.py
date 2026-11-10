"""CLI runner for standalone 5-protocol OT simulator container."""

from __future__ import annotations

import argparse
import asyncio
import signal

from tests.simulators.ot_simulators import SimulatorSuite


async def _main(args: argparse.Namespace) -> None:
    suite = SimulatorSuite(
        host=args.host,
        modbus_port=args.modbus_port,
        opcua_port=args.opcua_port,
        mqtt_port=args.mqtt_port,
        http_port=args.http_port,
        ws_port=args.ws_port,
        control_port=args.control_port,
    )
    ep = await suite.start()
    print(f"Simulators listening: {ep}", flush=True)
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass
    try:
        await stop_event.wait()
    finally:
        await suite.stop()


def main() -> None:
    p = argparse.ArgumentParser(description="FactoriX Isolated 5-Protocol OT Simulators")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--modbus-port", type=int, default=15020)
    p.add_argument("--opcua-port", type=int, default=14840)
    p.add_argument("--mqtt-port", type=int, default=11883)
    p.add_argument("--http-port", type=int, default=18443)
    p.add_argument("--ws-port", type=int, default=18765)
    p.add_argument("--control-port", type=int, default=19000)
    args = p.parse_args()
    asyncio.run(_main(args))


if __name__ == "__main__":
    main()
