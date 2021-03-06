# Copyright 2020 The FedLearner Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# coding: utf-8

import logging
import os
import time
try:
    import thread
    import threading
except ImportError:
    thread = None

if thread:
    _lock = threading.RLock()
else:
    _lock = None

_metrics_client = None


def _acquireLock():
    """
    Acquire the module-level lock for serializing access to shared data.

    This should be released with _releaseLock().
    """
    if _lock:
        _lock.acquire()


def _releaseLock():
    """
    Release the module-level lock acquired by calling _acquireLock().
    """
    if _lock:
        _lock.release()


class Handler(object):
    def __init__(self, name):
        self._name = name

    def emit(self, name, value, tags=None, metrics_type=None):
        """
        Do whatever it takes to actually log the specified logging record.

        This version is intended to be implemented by subclasses and so
        raises a NotImplementedError.
        """
        raise NotImplementedError('emit must be implemented '
                                  'by Handler subclasses')


class loggingHandler(Handler):
    def __init__(self):
        super(loggingHandler, self).__init__('logging')

    def emit(self, name, value, tags=None, metrics_type=None):
        logging.info('[metrics] name[%s] value[%s] tags[%s]', name, value,
                     str(tags))


class elasticSearchHandler(Handler):
    def __init__(self, ip, port):
        from elasticsearch import Elasticsearch # pylint: disable=C0415
        super(elasticSearchHandler, self).__init__('elasticsearch')
        self._es = Elasticsearch([ip], port=port)
        # initialize index for elastic search
        if self._es.indices.exists(index='metrics') is not True:
            self._es.indices.create(index='metrics')

    def emit(self, name, value, tags=None, metrics_type=None):
        action = {
            "name": name,
            "value": value,
            "tags": tags,
            "timestamp": int(time.time())
        }
        self._es.index(index="metrics", body=action)


class Metrics(object):
    def __init__(self):
        self.handlers = []

    def addHandler(self, hdlr):
        """
        Add the specified handler to this logger.
        """
        _acquireLock()
        try:
            if not (hdlr in self.handlers):  # pylint: disable=superfluous-parens
                self.handlers.append(hdlr)
        finally:
            _releaseLock()

    def removeHandler(self, hdlr):
        """
        Remove the specified handler from this logger.
        """
        _acquireLock()
        try:
            if hdlr in self.handlers:
                self.handlers.remove(hdlr)
        finally:
            _releaseLock()

    def emit(self, name, value, tags=None, metrics_type=None):
        if not self.handlers or len(self.handlers) == 0:
            print('no handlers. do nothing.')
            return

        for hdlr in self.handlers:
            try:
                hdlr.emit(name, value, tags, metrics_type)
            except Exception as e:  # pylint: disable=broad-except
                print('hdlr [%s] emit failed. [%s]' %
                      (hdlr.get_name(), repr(e)))


def initialize_metrics():

    if os.environ.get('ES_HOST', None) and os.environ.get('ES_PORT', None):
        handler = elasticSearchHandler(os.environ['ES_HOST'],
                                       os.environ['ES_PORT'])
        metrics_config(handler)
    else:
        handler = loggingHandler()
        metrics_config(handler)


def metrics_config(handler):
    _acquireLock()
    global _metrics_client  # pylint: disable=global-statement
    try:
        if not _metrics_client:
            _metrics_client = Metrics()
        _metrics_client.addHandler(handler)
    finally:
        _releaseLock()


def emit_counter(name, value, tags=None):
    if not _metrics_client:
        initialize_metrics()
    _metrics_client.emit(name, value, tags, 'counter')


def emit_store(name, value, tags=None):
    if not _metrics_client:
        initialize_metrics()
    _metrics_client.emit(name, value, tags, 'store')


def emit_timer(name, value, tags=None):
    if not _metrics_client:
        initialize_metrics()
    _metrics_client.emit(name, value, tags, 'timer')
