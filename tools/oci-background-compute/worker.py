#!/usr/bin/env python3
"""Low-priority numerical integration with fail-closed workload admission．"""
import json
import math
import multiprocessing
import os
import pathlib
import signal
import time

VERSION = '2.0.1'
STATE = pathlib.Path('/var/lib/qzss-background-compute/state.json')
READINESS = pathlib.Path('/var/lib/qzss-standby/state.json')
PAUSE = pathlib.Path('/run/qzss-background-compute.pause')
CPU_LIMIT = 25.0  # Other work only，excluding this worker's own CPU time．
STEAL_LIMIT = 70.0
MEMORY_FLOOR = 192 * 1024 * 1024
RESUME_SECONDS = 5


def group_cpu_seconds():
    for line in pathlib.Path('/proc/self/cgroup').read_text().splitlines():
        if line.startswith('0::'):
            folder = pathlib.Path('/sys/fs/cgroup') / line[3:].lstrip('/')
            values = dict(row.split() for row in (folder/'cpu.stat').read_text().splitlines())
            return int(values['usage_usec']) / 1_000_000
    raise ValueError('CPU accounting cgroup missing')


def cpu_sample(own=None):
    fields = list(map(int, pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    # Exclude stolen time from useful CPU use，but gate stolen time separately．
    return (sum(fields), sum(fields) - fields[3] - fields[4] - fields[7], fields[7], time.process_time() if own is None else own)


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
        self.pending_reason = None
        self.pending_since = None

    def update(self, reason, now, severe=False):
        # Brief CPU/steal spikes reduce calculation duty，rather than stopping it．
        delay = 0 if severe else {'foreground-cpu': 3, 'host-contention': 10}.get(reason, 0)
        if reason:
            if reason != self.pending_reason:
                self.pending_reason, self.pending_since = reason, now
            if now - self.pending_since >= delay:
                self.healthy_since = None
                return False, reason
        else:
            self.pending_reason = self.pending_since = None
        if self.healthy_since is None:
            self.healthy_since = now
        if now - self.healthy_since < RESUME_SECONDS:
            return False, 'resume-cooldown'
        return True, None


class Controller:
    def __init__(self, cpus, workers=1):
        self.cpus = cpus
        self.workers = workers
        self.duty = min(0.95, 0.30 * cpus / workers)
        self.last_foreground = 0

    def adjust(self, total, foreground):
        # Integrate observed utilization error，with immediate feed-forward when
        # application load increases．The kernel independently enforces CPUQuota．
        increase = max(0, foreground - self.last_foreground) * self.cpus / (100 * self.workers)
        error = 30.0 - total
        self.duty = min(0.95, max(0, self.duty - increase + (0.006 * error if abs(error) > 2 else 0)))
        self.last_foreground = foreground
        return self.duty


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


def integration_process(allowed, duty, shutdown, rounds, result, failed):
    calculation = Integration()
    while not shutdown.value:
        if not allowed.value:
            time.sleep(0.05)
            continue
        start = time.monotonic()
        try:
            while allowed.value and not shutdown.value and time.monotonic()-start < duty.value:
                calculation.block()
            rounds.value = calculation.rounds
            if calculation.last_result is not None:
                result.value = calculation.last_result
        except ArithmeticError:
            failed.value = 1
            return
        while not shutdown.value and allowed.value and time.monotonic()-start < 1:
            time.sleep(min(0.05, max(0, 1-(time.monotonic()-start))))


def main():
    os.umask(0o077)
    shutdown = multiprocessing.RawValue('b', 0)
    def stop(*_):
        shutdown.value = 1
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    ticks, cpus = os.sysconf('SC_CLK_TCK'), os.cpu_count() or 1
    worker_count = min(2, cpus)
    gate, controller = Gate(), Controller(cpus, worker_count)
    allowed, duty = multiprocessing.RawValue('b', 0), multiprocessing.RawValue('d', controller.duty)
    rounds = [multiprocessing.RawValue('Q', 0) for _ in range(worker_count)]
    results = [multiprocessing.RawValue('d', 0) for _ in range(worker_count)]
    failed = multiprocessing.RawValue('b', 0)
    previous = cpu_sample(group_cpu_seconds())
    processes = [multiprocessing.get_context('fork').Process(target=integration_process,
        args=(allowed, duty, shutdown, rounds[i], results[i], failed), daemon=True) for i in range(worker_count)]
    for process in processes:
        process.start()
    interval_start = time.monotonic()
    deadline = interval_start + 1
    running = False
    reason = 'initializing'
    last_label = None
    last_saved = 0
    last_pause = None
    try:
        last_pause = json.loads(STATE.read_text()).get('lastPause')
    except (OSError, ValueError):
        pass
    limits = {'targetCpuPct': 30, 'foregroundPausePct': CPU_LIMIT, 'foregroundPauseSeconds': 3, 'emergencyCpuPct': 60,
              'stealPausePct': STEAL_LIMIT, 'stealPauseSeconds': 10,
              'minMemoryBytes': MEMORY_FLOOR, 'resumeSeconds': RESUME_SECONDS,
              'maxWorkerCpuPct': 80 / cpus}
    while not shutdown.value:
        if failed.value or any(not process.is_alive() for process in processes):
            allowed.value = 0
            raise ArithmeticError('integration worker exited unexpectedly')
        time.sleep(max(0, deadline - time.monotonic()))
        mono, wall = time.monotonic(), time.time()
        readiness_age = None
        try:
            current = cpu_sample(group_cpu_seconds())
            cpu, steal = cpu_usage(previous, current, ticks, cpus)
            total_cpu = max(0, 100 * (current[1] - previous[1]) / (current[0] - previous[0]))
            previous = current
            memory = memory_available()
            readiness = json.loads(READINESS.read_text())
            readiness_age = max(0, wall - readiness.get('at', 0))
            requested = pause_reason(cpu, steal, memory, readiness, wall, PAUSE.exists())
        except (OSError, ValueError, TypeError, ZeroDivisionError):
            cpu = steal = memory = total_cpu = None
            requested = 'metrics-unavailable'
        was_running = running
        running, reason = gate.update(requested, mono, severe=cpu is not None and cpu >= 60)
        if running:
            if was_running:
                controller.adjust(total_cpu, cpu)
        else:
            controller = Controller(cpus, worker_count)
        duty.value, allowed.value = controller.duty, int(running)
        label = 'running' if running else reason
        changed = label != last_label
        if changed:
            if not running and reason not in ('resume-cooldown', 'initializing'):
                last_pause = {'at': wall, 'reason': reason, 'foregroundCpuPct': cpu,
                              'stealPct': steal, 'memoryAvailable': memory,
                              'readinessAgeSeconds': readiness_age}
            print(json.dumps({'state': 'running' if running else 'paused', 'reason': reason}), flush=True)
            last_label = label
        if changed or mono - last_saved >= 5:
            data = {'version': VERSION, 'at': wall, 'state': 'running' if running else 'paused', 'reason': reason,
                    'foregroundCpuPct': cpu, 'totalCpuPct': total_cpu, 'stealPct': steal,
                    'memoryAvailable': memory, 'targetCpuPct': 30, 'dutyPct': controller.duty * 100 if running else 0,
                    'limits': limits, 'lastPause': last_pause,
                    'rounds': sum(value.value for value in rounds), 'lastPi': next((value.value for value in results if value.value), None), 'workerCpuSeconds': group_cpu_seconds(), 'workers': worker_count}
            tmp = STATE.with_suffix('.tmp')
            tmp.write_text(json.dumps(data))
            tmp.chmod(0o644)
            tmp.replace(STATE)
            last_saved = mono
        interval_start, deadline = mono, mono + 1
    allowed.value = 0
    for process in processes:
        process.join(timeout=1)


if __name__ == '__main__':
    main()
