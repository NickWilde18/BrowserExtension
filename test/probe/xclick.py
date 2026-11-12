"""在当前 X 显示上用 XTest 发一次真实的鼠标左键点击（实测点调试提示条上的按钮用）。

用法：python3 -I xclick.py <x> <y>
"""
import ctypes
import sys
import time

x11 = ctypes.CDLL('libX11.so.6')
xtst = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit('cannot open display')

x, y = int(sys.argv[1]), int(sys.argv[2])
xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
x11.XFlush(display)
time.sleep(0.15)
xtst.XTestFakeButtonEvent(display, 1, 1, 0)
x11.XFlush(display)
time.sleep(0.05)
xtst.XTestFakeButtonEvent(display, 1, 0, 0)
x11.XFlush(display)
x11.XCloseDisplay(display)
print('clicked', x, y)
