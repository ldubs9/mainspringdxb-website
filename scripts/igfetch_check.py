#!/usr/bin/env python3
"""
igfetch_check.py — quick environment checker for igfetch (mainspring)
"""
import os

def check_env_var(var_name):
    return os.environ.get(var_name) is not None

if __name__ == '__main__':
    print('igfetch environment check')
    print('RAPIDAPI_KEY set:' , check_env_var('RAPIDAPI_KEY'))
    print('To run: python3 scripts/igfetch_fetch.py --username mainspring.dxb --count 6')
