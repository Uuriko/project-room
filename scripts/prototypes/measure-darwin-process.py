"""Test-only workerd process sampler. RSS samples are not a hard peak bound."""
import ctypes
import json
import sys
import threading
import time

pid = int(sys.argv[1])
lib = ctypes.CDLL('/usr/lib/libproc.dylib')
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
timebase = (ctypes.c_uint32 * 2)()
ctypes.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(timebase)
stop = threading.Event()

def sample():
    data = (ctypes.c_uint64 * 12)()
    if lib.proc_pidinfo(pid, 4, 0, data, 96) != 96:
        raise RuntimeError('proc_pidinfo failed')
    return {'residentBytes': data[1], 'cpuNs': data[2] + data[3]}

first = sample()
print(json.dumps({'ready': True, 'pid': pid}), flush=True)
threading.Thread(target=lambda: (sys.stdin.readline(), stop.set()), daemon=True).start()
peak = first['residentBytes']
count = 0
while not stop.wait(0.001):
    peak = max(peak, sample()['residentBytes'])
    count += 1
last = sample()
print(json.dumps({'beforeResidentBytes': first['residentBytes'],
                  'afterResidentBytes': last['residentBytes'],
                  'sampledPeakResidentBytes': max(peak, last['residentBytes']),
                  'processCpuTicks': last['cpuNs'] - first['cpuNs'],
                  'processCpuNs': (last['cpuNs'] - first['cpuNs']) * timebase[0] // timebase[1],
                  'timebaseNumer': timebase[0], 'timebaseDenom': timebase[1],
                  'samples': count, 'sampleIntervalMs': 1}), flush=True)
