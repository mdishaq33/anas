/**
 *    Copyright (C) 2018-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#pragma once

/**
 * DB usage monitor.
 */

#include <boost/date_time/posix_time/posix_time.hpp>
#include <cstdint>
#include <set>

#include "mongo/bson/bsonobjbuilder.h"
#include "mongo/db/commands.h"
#include "mongo/db/namespace_string.h"
#include "mongo/db/operation_context.h"
#include "mongo/db/service_context.h"
#include "mongo/db/stats/operation_latency_histogram.h"
#include "mongo/platform/mutex.h"
#include "mongo/rpc/message.h"
#include "mongo/util/concurrency/mutex.h"
#include "mongo/util/string_map.h"

namespace mongo {

class ServiceContext;

/**
 * tracks usage by collection
 */
class Top {
public:
    struct UsageData {
        UsageData() = default;
        long long time{0};
        long long count{0};

        void inc(long long micros) {
            count++;
            time += micros;
        }
    };

    struct CollectionData {
        CollectionData() = default;

        UsageData total;

        UsageData readLock;
        UsageData writeLock;

        UsageData queries;
        UsageData getmore;
        UsageData insert;
        UsageData update;
        UsageData remove;
        UsageData commands;

        OperationLatencyHistogram opLatencyHistogram;

        bool isStatsRecordingAllowed{true};
    };

    enum class LockType {
        ReadLocked,
        WriteLocked,
        NotLocked,
    };

    typedef StringMap<CollectionData> UsageMap;

    Top() = default;

    static Top& get(ServiceContext* service);

    void record(OperationContext* opCtx,
                const NamespaceString& nss,
                LogicalOp logicalOp,
                LockType lockType,
                long long micros,
                bool command,
                Command::ReadWriteType readWriteType);

    /**
     * Same as the above, but for multiple namespaces.
     */
    void record(OperationContext* opCtx,
                const std::set<NamespaceString>& nssSet,
                LogicalOp logicalOp,
                LockType lockType,
                long long micros,
                bool command,
                Command::ReadWriteType readWriteType);

    void append(BSONObjBuilder& b);

    void collectionDropped(const NamespaceString& nss);

    /**
     * Appends the collection-level latency statistics
     */
    void appendLatencyStats(const NamespaceString& nss,
                            bool includeHistograms,
                            BSONObjBuilder* builder);

    /**
     * Increments the global histogram only if the operation came from a user.
     */
    void incrementGlobalLatencyStats(OperationContext* opCtx,
                                     uint64_t latency,
                                     Command::ReadWriteType readWriteType);

    /**
     * Increments the global transactions histogram.
     */
    void incrementGlobalTransactionLatencyStats(OperationContext* opCtx, uint64_t latency);

    /**
     * Appends the global latency statistics.
     */
    void appendGlobalLatencyStats(bool includeHistograms,
                                  bool slowMSBucketsOnly,
                                  BSONObjBuilder* builder);

private:
    AtomicOperationLatencyHistogram _globalHistogramStats;

    // _lockUsage should always be acquired before using _usage.
    Mutex _lockUsage = MONGO_MAKE_LATCH("Top::_lockUsage");
    UsageMap _usage;
};

}  // namespace mongo
