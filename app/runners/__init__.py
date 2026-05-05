"""Job runner implementations.

The local runner currently lives in app/jobs.py for historical reasons; this
package is for newer / out-of-process runners. They all satisfy the JobRunner
Protocol declared in app/jobs.py.
"""
from .hf_cloud import HfCloudJobRunner

__all__ = ["HfCloudJobRunner"]
