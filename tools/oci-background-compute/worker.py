#!/usr/bin/env python3
"""Low-priority numerical integration with fail-closed workload admission．"""
import json
import math
import os
import pathlib
import signal
import time

VERSION = '1.0.1'
STATE = pathlib.Path('/var/lib/qzss-background-compute/state.json')
READINESS = pathlib.Path('/var/lib/qzss-standby/state.json')
PAUSE = pathlib.Path('/run/qzss-background-compute.pause')
CPU_LIMIT = 20.0  # Other work only，excluding this worker's own CPU time．
STEAL_LIMIT = 30.0
MEMORY_FLOOR = 192 * 1024 * 1024
RESUME_SECONDS = 15


def cpu_sample():
    fields = list(map(int, pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    # Exclude stolen time from useful CPU use，but gate stolen time separately．
    return (sum(fields), sum(fields) - fields[3] - fields[4] - fields[7], fields[7], time.process_time())


def cpu_usage(previous, current, clock_ticks, cpus):
    total = current[0] - previous[0]
    if total <= 0:
        raise ValueError('invalid CPU observation')
    own = max(0, current[3] - previous[3]) * clock_ticks
    return max(0, 100 * (current[1] - previous[1] - own) / total), 100 * (current[2] - previous[2]) / total


def memory_available():
    for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) * 1024
    raise ValueError('available memory missing')


def pause_reason(cpu, steal, memory, readiness, now, manual=False):
    if manual:
        return 'manual-pause'
    if not all(math.isfinite(x) for x in (cpu, steal, memory)):
        return 'metrics-unavailable'
    if cpu >= CPU_LIMIT:
        return 'foreground-cpu'
    if steal >= STEAL_LIMIT:
        return 'host-contention'
    if memory < MEMORY_FLOOR:
        return 'low-memory'
    age = now - readiness.get('at', 0)
    if not 0 <= age <= 60 or readiness.get('status') != 'ready' or readiness.get('notificationEnabled') is not True:
        return 'server-not-ready'
    return None


class Gate:
    def __init__(self):
        self.healthy_since = None

    def update(self, reason, now):
        if reason:
            self.healthy_since = None
            return False, reason
        if self.healthy_since is None:
            self.healthy_since = now
        if now - self.healthy_since < RESUME_SECONDS:
            return False, 'resume-cooldown'
        return True, None


class Integration:
    # Midpoint integration of 4/(1+x*x) from 0 to 1．No growing arrays or files．
    def __init__(self, subdivisions=1_000_000):
        self.n = subdivisions
        self.index = 0
        self.total = 0.0
        self.rounds = 0
        self.last_result = None

    def block(self, count=4096):
        end = min(self.n, self.index + count)
        for i in range(self.index, end):
            x = (i + 0.5) / self.n
            self.total += 4.0 / (1.0 + x * x)
        self.index = end
        if end == self.n:
            self.last_result = self.total / self.n
            if not math.isfinite(self.last_result) or abs(self.last_result - math.pi) > 1e-8:
                raise ArithmeticError('numerical integration validation failed')
            self.rounds += 1
            self.index = 0
            self.total = 0.0


def main():
    os.umask(0o077)
    stopped = False

    def stop(*_):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    clock_ticks = os.sysconf('SC_CLK_TCK')
    cpus = os.cpu_count() or 1
    gate, calculation = Gate(), Integration()
    previous = cpu_sample()
    deadline = time.monotonic() + 1
    running = False
    reason = 'initializing'
    last_reason = None
    last_saved = 0
    while not stopped:
        if running and time.monotonic() < deadline:
            calculation.block()
            continue
        time.sleep(max(0, deadline - time.monotonic()))
        mono, wall = time.monotonic(), time.time()
        try:
            current = cpu_sample()
            cpu, steal = cpu_usage(previous, current, clock_ticks, cpus)
            previous = current
            memory = memory_available()
            readiness = json.loads(READINESS.read_text())
            reason = pause_reason(cpu, steal, memory, readiness, wall, PAUSE.exists())
        except (OSError, ValueError, TypeError):
            cpu = steal = memory = None
            reason = 'metrics-unavailable'
        running, reason = gate.update(reason, mono)
        label = 'running' if running else reason
        if label != last_reason:
            print(json.dumps({'state': 'running' if running else 'paused', 'reason': reason}), flush=True)
            last_reason = label
        if mono - last_saved >= 10:
            data = {'version': VERSION, 'at': wall, 'state': 'running' if running else 'paused', 'reason': reason,
                    'foregroundCpuPct': cpu, 'stealPct': steal, 'memoryAvailable': memory,
                    'rounds': calculation.rounds, 'lastPi': calculation.last_result, 'workerCpuSeconds': time.process_time()}
            tmp = STATE.with_suffix('.tmp')
            tmp.write_text(json.dumps(data))
            tmp.chmod(0o644)  # Numeric status only，readable by the unprivileged metrics collector．
            tmp.replace(STATE)
            last_saved = mono
        deadline = mono + 1


if __name__ == '__main__':
    main()
