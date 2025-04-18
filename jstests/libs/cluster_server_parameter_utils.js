/**
 * Util functions used by cluster server parameter tests.
 *
 * When adding new cluster server parameter, do the following:
 *   If it's test-only, add its definition to kTestOnlyClusterParameters.
 *   Otherwise, add to kNonTestOnlyClusterParameters.
 * The keyname will be the name of the cluster-wide server parameter,
 * it's value will be an object with at least three keys named:
 *   * 'default': Properties to expect on an unset CWSP
 *   * 'testValues': List of two other valid values of the CWSP to set for testing purposes
 * An additional property 'featureFlag' may also be set if the
 *   parameter depends on a featureFlag.
 * Use the name of the featureFlag if it is required in
 *   order to consider the parameter.
 * Prefix the name with a bang '!' if it is only considered
 *   when the featureFlag is disabled.
 */

import {FeatureFlagUtil} from "jstests/libs/feature_flag_util.js";
import {
    makeUnsignedSecurityToken,
    runCommandWithSecurityToken
} from "jstests/libs/multitenancy_utils.js";

export const kNonTestOnlyClusterParameters = {
    changeStreamOptions: {
        default: {preAndPostImages: {expireAfterSeconds: 'off'}},
        testValues: [
            {preAndPostImages: {expireAfterSeconds: 30}},
            {preAndPostImages: {expireAfterSeconds: 20}}
        ],
        featureFlag: '!ServerlessChangeStreams',
        standaloneIncompatible: false,
    },
    changeStreams: {
        default: {expireAfterSeconds: NumberLong(3600)},
        testValues: [{expireAfterSeconds: 30}, {expireAfterSeconds: 10}],
        featureFlag: 'ServerlessChangeStreams',
        setParameters: {'multitenancySupport': true},
        serverless: true,
        standaloneIncompatible: false,
    },
    defaultMaxTimeMS: {
        default: {readOperations: 0},
        testValues: [{readOperations: 42}, {readOperations: 60000}],
        featureFlag: 'DefaultReadMaxTimeMS',
        setParameters: {'multitenancySupport': true},
        serverless: true,
        standaloneIncompatible: false,
    }
};

export const kTestOnlyClusterParameters = {
    cwspTestNeedsFeatureFlagClusterWideToaster: {
        default: {intData: 16},
        testValues: [{intData: 17}, {intData: 18}],
        featureFlag: 'ClusterWideToaster',
    },
    testStrClusterParameter: {
        default: {strData: 'off'},
        testValues: [{strData: 'on'}, {strData: 'sleep'}],
    },
    testIntClusterParameter: {
        default: {intData: 16},
        testValues: [{intData: 17}, {intData: 18}],
    },
    testBoolClusterParameter: {
        default: {boolData: false},
        testValues: [{boolData: true}, {boolData: false}],
    },
};

export const kOmittedInFTDCClusterParameterNames = ['testBoolClusterParameter'];

export const kAllClusterParameters =
    Object.assign({}, kNonTestOnlyClusterParameters, kTestOnlyClusterParameters);

export const kAllClusterParameterNames = Object.keys(kAllClusterParameters);

export const kAllClusterParameterDefaults = kAllClusterParameterNames.map(
    (name) => Object.assign({_id: name}, kAllClusterParameters[name].default));

export const kAllClusterParameterValues1 = kAllClusterParameterNames.map(
    (name) => Object.assign({_id: name}, kAllClusterParameters[name].testValues[0]));

export const kAllClusterParameterValues2 = kAllClusterParameterNames.map(
    (name) => Object.assign({_id: name}, kAllClusterParameters[name].testValues[1]));

export const kNonTestOnlyClusterParameterDefaults =
    Object.keys(kNonTestOnlyClusterParameters)
        .map((name) => Object.assign({_id: name}, kAllClusterParameters[name].default));

export function considerParameter(paramName, conn) {
    // { featureFlag: 'name' } indicates that the CWSP should only be considered with the FF
    // enabled. { featureFlag: '!name' } indicates that the CWSP should only be considered with the
    // FF disabled.
    function validateFeatureFlag(cp) {
        if (cp.featureFlag) {
            const considerWhenFFEnabled = cp.featureFlag[0] !== '!';
            const ff = cp.featureFlag.substr(considerWhenFFEnabled ? 0 : 1);
            return FeatureFlagUtil.isEnabled(conn, ff) === considerWhenFFEnabled;
        }
        return true;
    }

    // A dictionary of 'setParameters' that should be validated while considering the current CWSP.
    function validateSetParameter(cp) {
        if (cp.setParameters) {
            for (let [param, value] of Object.entries(cp.setParameters)) {
                const resp = conn.getDB("admin").runCommand({getParameter: 1, param: 1});
                const hasParam = resp.hasOwnProperty(param) && resp[param] === value;
                if (!hasParam) {
                    return false;
                }
            }
        }
        return true;
    }

    // Check if the current CWSP should be run in the serverless.
    function validateServerless(cp) {
        if (cp.hasOwnProperty("serverless")) {
            const resp =
                assert.commandWorked(conn.getDB("admin").adminCommand({getCmdLineOpts: 1}));
            return cp.serverless === resp.parsed && resp.parsed.replication &&
                resp.parsed.replication.serverless;
        }
        return true;
    }

    // Check if the current CWSP should be run in standalone.
    function validateStandalone(cp) {
        if (cp.hasOwnProperty("standaloneIncompatible")) {
            const hello = conn.getDB("admin").runCommand({hello: 1});
            const isStandalone = hello.msg !== "isdbgrid" && !hello.hasOwnProperty('setName');
            return !isStandalone;
        }
        return true;
    }

    const cp = kAllClusterParameters[paramName] || {};
    return validateFeatureFlag(cp) && validateSetParameter(cp) && validateServerless(cp) &&
        validateStandalone(cp);
}

// Set the log level for get/setClusterParameter logging to appear.
export function setupNode(conn) {
    const adminDB = conn.getDB('admin');
    adminDB.setLogLevel(2);
}

export function setupReplicaSet(rst) {
    setupNode(rst.getPrimary());

    rst.getSecondaries().forEach(function(secondary) {
        setupNode(secondary);
    });
}

export function setupSharded(st) {
    setupNode(st.s0);

    const shards = [st.rs0, st.rs1, st.rs2];
    shards.forEach(function(shard) {
        setupReplicaSet(shard);
    });

    // Wait for FCV to fully replicate on all shards before performing test commands.
    st.awaitReplicationOnShards();
}

// Upserts config.clusterParameters document with w:majority via setClusterParameter.
export function runSetClusterParameter(conn, update, tenantId) {
    const paramName = update._id;
    if (!considerParameter(paramName, conn)) {
        return;
    }
    let updateCopy = Object.assign({}, update);
    delete updateCopy._id;
    delete updateCopy.clusterParameterTime;
    const setClusterParameterDoc = {
        [paramName]: updateCopy,
    };

    const adminDB = conn.getDB('admin');
    const tenantToken =
        tenantId ? makeUnsignedSecurityToken(tenantId, {expectPrefix: false}) : undefined;
    assert.commandWorked(runCommandWithSecurityToken(
        tenantToken, adminDB, {setClusterParameter: setClusterParameterDoc}));
}

// Runs getClusterParameter on a specific mongod or mongos node and returns true/false depending
// on whether the expected values were returned.
export function runGetClusterParameterNode(conn,
                                           getClusterParameterArgs,
                                           allExpectedClusterParameters,
                                           tenantId = undefined,
                                           omitInFTDC = false,
                                           omittedInFTDCClusterParameters = []) {
    const tenantToken =
        tenantId ? makeUnsignedSecurityToken(tenantId, {expectPrefix: false}) : undefined;
    const adminDB = conn.getDB('admin');

    // Filter out parameters that we don't care about.
    if (Array.isArray(getClusterParameterArgs)) {
        getClusterParameterArgs =
            getClusterParameterArgs.filter((name) => considerParameter(name, conn));
    } else if ((typeof getClusterParameterArgs === 'string') &&
               !considerParameter(getClusterParameterArgs, conn)) {
        return true;
    }

    // Update getClusterParameter command and expectedClusterParameters based on whether
    // omitInFTDC has been set.
    let getClusterParameterCmd = {getClusterParameter: getClusterParameterArgs};
    let expectedClusterParameters = allExpectedClusterParameters.slice();
    if (omitInFTDC) {
        getClusterParameterCmd['omitInFTDC'] = true;
        expectedClusterParameters =
            allExpectedClusterParameters.filter(expectedClusterParameter => {
                return !omittedInFTDCClusterParameters.find(
                    (testOnlyParameter) => testOnlyParameter == expectedClusterParameter._id);
            });
    }
    const actualClusterParameters = assert
                                        .commandWorked(runCommandWithSecurityToken(
                                            tenantToken, adminDB, getClusterParameterCmd))
                                        .clusterParameters;

    // Reindex actual based on name, and remove irrelevant field.
    let actual = {};
    actualClusterParameters.forEach(function(acp) {
        actual[acp._id] = acp;
        delete actual[acp._id].clusterParameterTime;
    });

    for (let i = 0; i < expectedClusterParameters.length; i++) {
        if (!considerParameter(expectedClusterParameters[i]._id, conn)) {
            continue;
        }

        const id = expectedClusterParameters[i]._id;
        if (actual[id] === undefined) {
            jsTest.log('Expected to retreive ' + id + ' but it was not returned');
            return false;
        }

        if (bsonWoCompare(expectedClusterParameters[i], actual[id]) !== 0) {
            jsTest.log('Server parameter mismatch on node: ' + conn.host + '\n' +
                       'Expected: ' + tojson(expectedClusterParameters[i]) + '\n' +
                       'Actual: ' + tojson(actual[id]));
            return false;
        }
    }

    // Finally, if omitInFTDC is true, assert that all redacted cluster parameters are not
    // in the reply.
    if (omitInFTDC) {
        for (let i = 0; i < omittedInFTDCClusterParameters.length; i++) {
            if (!considerParameter(omittedInFTDCClusterParameters[i], conn)) {
                continue;
            }

            if (actual[omittedInFTDCClusterParameters[i]] !== undefined) {
                jsTest.log('getClusterParameter returned parameter ' +
                           omittedInFTDCClusterParameters[i] +
                           ', Actual reply: ' + tojson(actual[omittedInFTDCClusterParameters[i]]));
                return false;
            }
        }
    }

    return true;
}

// Runs getClusterParameter on each replica set node and asserts that the response matches the
// expected parameter objects on at least a majority of nodes.
export function runGetClusterParameterReplicaSet(rst,
                                                 getClusterParameterArgs,
                                                 expectedClusterParameters,
                                                 tenantId = undefined,
                                                 omitInFTDC = false,
                                                 omittedInFTDCClusterParameters = []) {
    let numMatches = 0;
    const numTotalNodes = rst.getSecondaries().length + 1;
    if (runGetClusterParameterNode(rst.getPrimary(),
                                   getClusterParameterArgs,
                                   expectedClusterParameters,
                                   tenantId,
                                   omitInFTDC,
                                   omittedInFTDCClusterParameters)) {
        numMatches++;
    }

    rst.awaitReplication();
    rst.getSecondaries().forEach(function(secondary) {
        if (runGetClusterParameterNode(secondary,
                                       getClusterParameterArgs,
                                       expectedClusterParameters,
                                       tenantId,
                                       omitInFTDC,
                                       omittedInFTDCClusterParameters)) {
            numMatches++;
        }
    });

    assert((numMatches / numTotalNodes) > 0.5);
}

// Runs getClusterParameter on mongos, each mongod in each shard replica set, and each mongod in
// the config server replica set.
export function runGetClusterParameterSharded(st,
                                              getClusterParameterArgs,
                                              expectedClusterParameters,
                                              tenantId = undefined,
                                              omitInFTDC = false,
                                              omittedInFTDCClusterParameters = []) {
    assert(runGetClusterParameterNode(st.s0,
                                      getClusterParameterArgs,
                                      expectedClusterParameters,
                                      tenantId,
                                      omitInFTDC,
                                      omittedInFTDCClusterParameters));

    runGetClusterParameterReplicaSet(st.configRS,
                                     getClusterParameterArgs,
                                     expectedClusterParameters,
                                     tenantId,
                                     omitInFTDC,
                                     omittedInFTDCClusterParameters);
    const shards = [st.rs0, st.rs1, st.rs2];
    shards.forEach(function(shard) {
        runGetClusterParameterReplicaSet(shard,
                                         getClusterParameterArgs,
                                         expectedClusterParameters,
                                         tenantId,
                                         omitInFTDC,
                                         omittedInFTDCClusterParameters);
    });
}

// Tests valid usages of set/getClusterParameter and verifies that the expected values are returned.
export function testValidClusterParameterCommands(conn) {
    if (conn instanceof ReplSetTest) {
        // Run getClusterParameter in list format and '*' with omitInFTDC = true and ensure that
        // it does not return any parameters that should be omitted for FTDC.
        runGetClusterParameterReplicaSet(conn,
                                         kAllClusterParameterNames,
                                         kAllClusterParameterDefaults,
                                         undefined,
                                         true /* omitInFTDC */,
                                         kOmittedInFTDCClusterParameterNames);
        runGetClusterParameterReplicaSet(conn,
                                         '*',
                                         kAllClusterParameterDefaults,
                                         undefined,
                                         true /* omitInFTDC */,
                                         kOmittedInFTDCClusterParameterNames);

        // Run getClusterParameter in list format and '*' and ensure it returns all default values
        // on all nodes in the replica set.
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames, kAllClusterParameterDefaults);
        runGetClusterParameterReplicaSet(conn, '*', kAllClusterParameterDefaults);

        // For each parameter, run setClusterParameter and verify that getClusterParameter
        // returns the updated value on all nodes in the replica set.
        for (let i = 0; i < kAllClusterParameterNames.length; i++) {
            runSetClusterParameter(conn.getPrimary(), kAllClusterParameterValues1[i]);
            runGetClusterParameterReplicaSet(
                conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]]);

            // Verify that document updates are also handled properly.
            runSetClusterParameter(conn.getPrimary(), kAllClusterParameterValues2[i]);
            runGetClusterParameterReplicaSet(
                conn, kAllClusterParameterNames[i], [kAllClusterParameterValues2[i]]);
        }

        // Finally, run getClusterParameter in list format and '*' and ensure that they now all
        // return updated values.
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames, kAllClusterParameterValues2);
        runGetClusterParameterReplicaSet(conn, '*', kAllClusterParameterValues2);
    } else if (conn instanceof ShardingTest) {
        // Run getClusterParameter in list format and '*' and ensure it returns all default values
        // on all nodes in the sharded cluster.
        runGetClusterParameterSharded(
            conn, kAllClusterParameterNames, kAllClusterParameterDefaults);
        runGetClusterParameterSharded(conn, '*', kAllClusterParameterDefaults);

        // For each parameter, simulate setClusterParameter and verify that getClusterParameter
        // returns the updated value on all nodes in the sharded cluster.
        for (let i = 0; i < kAllClusterParameterNames.length; i++) {
            runSetClusterParameter(conn.s0, kAllClusterParameterValues1[i]);
            runGetClusterParameterSharded(
                conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]]);

            // Verify that document updates are also handled properly.
            runSetClusterParameter(conn.s0, kAllClusterParameterValues2[i]);
            runGetClusterParameterSharded(
                conn, kAllClusterParameterNames[i], [kAllClusterParameterValues2[i]]);
        }

        // Finally, run getClusterParameter in list format and '*' and ensure that they now all
        // return updated values.
        runGetClusterParameterSharded(conn, kAllClusterParameterNames, kAllClusterParameterValues2);
        runGetClusterParameterSharded(conn, '*', kAllClusterParameterValues2);
    } else {  // Standalone
        // Run getClusterParameter in list format and '*' and ensure it returns all default values.
        assert(runGetClusterParameterNode(
            conn, kAllClusterParameterNames, kAllClusterParameterDefaults));
        assert(runGetClusterParameterNode(conn, '*', kAllClusterParameterDefaults));

        // For each parameter, run setClusterParameter and verify that getClusterParameter
        // returns the updated value.
        for (let i = 0; i < kAllClusterParameterNames.length; i++) {
            runSetClusterParameter(conn, kAllClusterParameterValues1[i]);
            assert(runGetClusterParameterNode(
                conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]]));

            // Verify that document updates are also handled properly.
            runSetClusterParameter(conn, kAllClusterParameterValues2[i]);
            assert(runGetClusterParameterNode(
                conn, kAllClusterParameterNames[i], [kAllClusterParameterValues2[i]]));
        }

        // Finally, run getClusterParameter in list format and '*' and ensure that they now return
        // updated values.
        assert(runGetClusterParameterNode(
            conn, kAllClusterParameterNames, kAllClusterParameterValues2));
        assert(runGetClusterParameterNode(conn, '*', kAllClusterParameterValues2));
    }
}

export const tenantId1 = ObjectId();
export const tenantId2 = ObjectId();

// Tests valid usages of set/getClusterParameter on a serverless replica set and verifies that the
// expected values are returned.
export function testValidServerlessClusterParameterCommands(conn) {
    // TODO SERVER-69663 Add serverless sharded cluster tests once supported.
    assert(conn instanceof ReplSetTest);
    assert(
        !considerParameter("changeStreamOptions", conn.getPrimary()),
        "As changeStreamOptions is not supported for serverless configurations, the feature flag ServerlessChangeStreams must be enabled to run this test.");

    // Run getClusterParameter in list format and '*' and ensure it returns all default values
    // on all nodes in the replica set, with and without tenantId set.
    runGetClusterParameterReplicaSet(conn, kAllClusterParameterNames, kAllClusterParameterDefaults);
    runGetClusterParameterReplicaSet(conn, '*', kAllClusterParameterDefaults);
    runGetClusterParameterReplicaSet(
        conn, kAllClusterParameterNames, kAllClusterParameterDefaults, tenantId1);
    runGetClusterParameterReplicaSet(conn, '*', kAllClusterParameterDefaults, tenantId1);

    // Run getClusterParameter in list format and '*' and ensure that it filters out parameters
    // that should be omitted in FTDC when omitInFTDC is set for a specific tenant.
    runGetClusterParameterReplicaSet(conn,
                                     kAllClusterParameterNames,
                                     kAllClusterParameterDefaults,
                                     tenantId1,
                                     true /* omitInFTDC */,
                                     kOmittedInFTDCClusterParameterNames);
    runGetClusterParameterReplicaSet(conn,
                                     '*',
                                     kAllClusterParameterDefaults,
                                     tenantId1,
                                     true /* omitInFTDC */,
                                     kOmittedInFTDCClusterParameterNames);

    // For each parameter, run setClusterParameter and verify that getClusterParameter
    // returns the updated value on all nodes in the replica set for the tenant it was set on.
    for (let i = 0; i < kAllClusterParameterNames.length; i++) {
        // Test inserts for tenant1 and default tenant.
        runSetClusterParameter(conn.getPrimary(), kAllClusterParameterValues1[i], tenantId1);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]], tenantId1);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterDefaults[i]], tenantId2);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterDefaults[i]]);

        runSetClusterParameter(conn.getPrimary(), kAllClusterParameterValues2[i]);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterValues2[i]]);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]], tenantId1);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterDefaults[i]], tenantId2);

        // Test updates for tenant1 and default tenant.
        runSetClusterParameter(conn.getPrimary(), kAllClusterParameterValues1[i]);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]]);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]], tenantId1);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterDefaults[i]], tenantId2);

        runSetClusterParameter(conn.getPrimary(), kAllClusterParameterValues2[i], tenantId1);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterValues1[i]]);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterValues2[i]], tenantId1);
        runGetClusterParameterReplicaSet(
            conn, kAllClusterParameterNames[i], [kAllClusterParameterDefaults[i]], tenantId2);
    }

    // Finally, run getClusterParameter in list format and '*' and ensure that they now all
    // return updated values.
    runGetClusterParameterReplicaSet(conn, kAllClusterParameterNames, kAllClusterParameterValues1);
    runGetClusterParameterReplicaSet(conn, '*', kAllClusterParameterValues1);
    runGetClusterParameterReplicaSet(
        conn, kAllClusterParameterNames, kAllClusterParameterValues2, tenantId1);
    runGetClusterParameterReplicaSet(conn, '*', kAllClusterParameterValues2, tenantId1);
    runGetClusterParameterReplicaSet(
        conn, kAllClusterParameterNames, kAllClusterParameterDefaults, tenantId2);
    runGetClusterParameterReplicaSet(conn, '*', kAllClusterParameterDefaults, tenantId2);
}

// Assert that explicitly getting a disabled cluster server parameter fails on a node.
export function testExplicitDisabledGetClusterParameter(conn, tenantId) {
    const tenantToken =
        tenantId ? makeUnsignedSecurityToken(tenantId, {expectPrefix: false}) : undefined;
    const adminDB = conn.getDB('admin');
    assert.commandFailedWithCode(
        runCommandWithSecurityToken(
            tenantToken, adminDB, {getClusterParameter: "testIntClusterParameter"}),
        ErrorCodes.BadValue);
    assert.commandFailedWithCode(
        runCommandWithSecurityToken(tenantToken, adminDB, {
            getClusterParameter: ["changeStreamOptions", "testIntClusterParameter"]
        }),
        ErrorCodes.BadValue);
}

// Tests that disabled cluster server parameters return errors or are filtered out as appropriate
// by get/setClusterParameter.
export function testDisabledClusterParameters(conn, tenantId) {
    const tenantToken =
        tenantId ? makeUnsignedSecurityToken(tenantId, {expectPrefix: false}) : undefined;
    if (conn instanceof ReplSetTest) {
        // Assert that explicitly setting a disabled cluster server parameter fails.
        const adminDB = conn.getPrimary().getDB('admin');
        assert.commandFailedWithCode(
            runCommandWithSecurityToken(tenantToken, adminDB, {
                setClusterParameter: {testIntClusterParameter: {intData: 5}}
            }),
            ErrorCodes.BadValue);

        // Assert that explicitly getting a disabled cluster server parameter fails on the primary.
        testExplicitDisabledGetClusterParameter(conn.getPrimary(), tenantId);

        // Assert that explicitly getting a disabled cluster server parameter fails on secondaries.
        conn.getSecondaries().forEach(function(secondary) {
            testExplicitDisabledGetClusterParameter(secondary, tenantId);
        });

        // Assert that getClusterParameter: '*' succeeds but only returns enabled cluster
        // parameters.
        runGetClusterParameterReplicaSet(conn, '*', kNonTestOnlyClusterParameterDefaults, tenantId);
    } else if (conn instanceof ShardingTest) {
        // Assert that explicitly setting a disabled cluster server parameter fails.
        const adminDB = conn.s0.getDB('admin');
        assert.commandFailedWithCode(
            runCommandWithSecurityToken(tenantToken, adminDB, {
                setClusterParameter: {testIntClusterParameter: {intData: 5}}
            }),
            ErrorCodes.BadValue);

        // Assert that explicitly getting a disabled cluster server parameter fails on mongos.
        testExplicitDisabledGetClusterParameter(conn.s0, tenantId);

        // Assert that explicitly getting a disabled cluster server parameter on each shard replica
        // set and the config replica set fails.
        const shards = [conn.rs0, conn.rs1, conn.rs2];
        const configRS = conn.configRS;
        shards.forEach(function(shard) {
            testExplicitDisabledGetClusterParameter(shard.getPrimary(), tenantId);
            shard.getSecondaries().forEach(function(secondary) {
                testExplicitDisabledGetClusterParameter(secondary, tenantId);
            });
        });

        testExplicitDisabledGetClusterParameter(configRS.getPrimary());
        configRS.getSecondaries().forEach(function(secondary) {
            testExplicitDisabledGetClusterParameter(secondary, tenantId);
        });

        // Assert that getClusterParameter: '*' succeeds but only returns enabled cluster
        // parameters.
        runGetClusterParameterSharded(conn, '*', kNonTestOnlyClusterParameterDefaults, tenantId);
    } else {  // Standalone
        // Assert that explicitly setting a disabled cluster server parameter fails.
        const adminDB = conn.getDB('admin');
        assert.commandFailedWithCode(
            runCommandWithSecurityToken(tenantToken, adminDB, {
                setClusterParameter: {testIntClusterParameter: {intData: 5}}
            }),
            ErrorCodes.BadValue);

        // Assert that explicitly getting a disabled cluster server parameter fails.
        testExplicitDisabledGetClusterParameter(conn, tenantId);

        // Assert that getClusterParameter: '*' succeeds but only returns enabled cluster
        // parameters.
        assert(
            runGetClusterParameterNode(conn, '*', kNonTestOnlyClusterParameterDefaults, tenantId));
    }
}

// Tests that invalid uses of getClusterParameter fails on a given node.
export function testInvalidGetClusterParameter(conn, tenantId) {
    const tenantToken =
        tenantId ? makeUnsignedSecurityToken(tenantId, {expectPrefix: false}) : undefined;
    const adminDB = conn.getDB('admin');
    // Assert that specifying a nonexistent parameter returns an error.
    assert.commandFailedWithCode(
        runCommandWithSecurityToken(
            tenantToken, adminDB, {getClusterParameter: "nonexistentParam"}),
        ErrorCodes.NoSuchKey);
    assert.commandFailedWithCode(
        runCommandWithSecurityToken(
            tenantToken, adminDB, {getClusterParameter: ["nonexistentParam"]}),
        ErrorCodes.NoSuchKey);
    assert.commandFailedWithCode(
        runCommandWithSecurityToken(tenantToken, adminDB, {
            getClusterParameter: ["testIntClusterParameter", "nonexistentParam"]
        }),
        ErrorCodes.NoSuchKey);
    assert.commandFailedWithCode(
        runCommandWithSecurityToken(tenantToken, adminDB, {getClusterParameter: []}),
        ErrorCodes.BadValue);
}

// Tests that invalid uses of set/getClusterParameter fail with the appropriate errors.
export function testInvalidClusterParameterCommands(conn, tenantId) {
    const tenantToken =
        tenantId ? makeUnsignedSecurityToken(tenantId, {expectPrefix: false}) : undefined;
    if (conn instanceof ReplSetTest) {
        const adminDB = conn.getPrimary().getDB('admin');

        // Assert that invalid uses of getClusterParameter fail on the primary.
        testInvalidGetClusterParameter(conn.getPrimary(), tenantId);

        // Assert that setting a nonexistent parameter on the primary returns an error.
        assert.commandFailed(runCommandWithSecurityToken(
            tenantToken, adminDB, {setClusterParameter: {nonexistentParam: {intData: 5}}}));

        // Assert that running setClusterParameter with a scalar value fails.
        assert.commandFailed(runCommandWithSecurityToken(
            tenantToken, adminDB, {setClusterParameter: {testIntClusterParameter: 5}}));

        conn.getSecondaries().forEach(function(secondary) {
            // Assert that setClusterParameter cannot be run on a secondary.
            const secondaryAdminDB = secondary.getDB('admin');
            assert.commandFailedWithCode(
                runCommandWithSecurityToken(tenantToken, secondaryAdminDB, {
                    setClusterParameter: {testIntClusterParameter: {intData: 5}}
                }),
                ErrorCodes.NotWritablePrimary);
            // Assert that invalid uses of getClusterParameter fail on secondaries.
            testInvalidGetClusterParameter(secondary, tenantId);
        });

        // Assert that invalid direct writes to <tenantId>_config.clusterParameters fail.
        assert.commandFailed(conn.getPrimary().getDB("config").clusterParameters.insert({
            _id: 'testIntClusterParameter',
            foo: 'bar',
            clusterParameterTime: {"$timestamp": {t: 0, i: 0}}
        }));
    } else if (conn instanceof ShardingTest) {
        const adminDB = conn.s0.getDB('admin');

        // Assert that invalid uses of getClusterParameter fail on mongos.
        testInvalidGetClusterParameter(conn.s0, tenantId);

        // Assert that setting a nonexistent parameter on the mongos returns an error.
        assert.commandFailed(runCommandWithSecurityToken(
            tenantToken, adminDB, {setClusterParameter: {nonexistentParam: {intData: 5}}}));

        // Assert that running setClusterParameter with a scalar value fails.
        assert.commandFailed(runCommandWithSecurityToken(
            tenantToken, adminDB, {setClusterParameter: {testIntClusterParameter: 5}}));

        const shards = [conn.rs0, conn.rs1, conn.rs2];
        shards.forEach(function(shard) {
            // Assert that setClusterParameter cannot be run directly on a shard primary.
            const shardPrimaryAdmin = shard.getPrimary().getDB('admin');
            assert.commandFailedWithCode(
                runCommandWithSecurityToken(tenantToken, shardPrimaryAdmin, {
                    setClusterParameter: {testIntClusterParameter: {intData: 5}}
                }),
                ErrorCodes.NotImplemented);
            // Assert that invalid forms of getClusterParameter fail on the shard primary.
            testInvalidGetClusterParameter(shard.getPrimary(), tenantId);
            shard.getSecondaries().forEach(function(secondary) {
                // Assert that setClusterParameter cannot be run on a shard secondary.
                const shardSecondaryAdmin = secondary.getDB('admin');
                assert.commandFailedWithCode(
                    runCommandWithSecurityToken(tenantToken, shardSecondaryAdmin, {
                        setClusterParameter: {testIntClusterParameter: {intData: 5}}
                    }),
                    ErrorCodes.NotWritablePrimary);
                // Assert that invalid forms of getClusterParameter fail on shard secondaries.
                testInvalidGetClusterParameter(secondary, tenantId);
            });
        });

        // Assert that setClusterParameter cannot be run directly on the configsvr primary.
        const configRS = conn.configRS;
        const configPrimaryAdmin = configRS.getPrimary().getDB('admin');
        assert.commandFailedWithCode(
            runCommandWithSecurityToken(tenantToken, configPrimaryAdmin, {
                setClusterParameter: {testIntClusterParameter: {intData: 5}}
            }),
            ErrorCodes.NotImplemented);
        // Assert that invalid forms of getClusterParameter fail on the configsvr primary.
        testInvalidGetClusterParameter(configRS.getPrimary(), tenantId);
        configRS.getSecondaries().forEach(function(secondary) {
            // Assert that setClusterParameter cannot be run on a configsvr secondary.
            const configSecondaryAdmin = secondary.getDB('admin');
            assert.commandFailedWithCode(
                runCommandWithSecurityToken(tenantToken, configSecondaryAdmin, {
                    setClusterParameter: {testIntClusterParameter: {intData: 5}}
                }),
                ErrorCodes.NotWritablePrimary);
            // Assert that invalid forms of getClusterParameter fail on configsvr secondaries.
            testInvalidGetClusterParameter(secondary, tenantId);
        });
        // Assert that invalid direct writes to <tenantId>_config.clusterParameters fail.
        assert.commandFailed(configRS.getPrimary().getDB("config").clusterParameters.insert({
            _id: 'testIntClusterParameter',
            foo: 'bar',
            clusterParameterTime: {"$timestamp": {t: 0, i: 0}}
        }));
        shards.forEach(function(shard) {
            assert.commandFailed(shard.getPrimary().getDB("config").clusterParameters.insert({
                _id: 'testIntClusterParameter',
                foo: 'bar',
                clusterParameterTime: {"$timestamp": {t: 0, i: 0}}
            }));
        });
    } else {  // Standalone
        const adminDB = conn.getDB('admin');

        // Assert that invalid uses of getClusterParameter fail.
        testInvalidGetClusterParameter(conn, tenantId);

        // Assert that setting a nonexistent parameter returns an error.
        assert.commandFailed(runCommandWithSecurityToken(
            tenantToken, adminDB, {setClusterParameter: {nonexistentParam: {intData: 5}}}));

        // Assert that running setClusterParameter with a scalar value fails.
        assert.commandFailed(runCommandWithSecurityToken(
            tenantToken, adminDB, {setClusterParameter: {testIntClusterParameter: 5}}));

        // Assert that invalid direct writes to <tenantId>_config.clusterParameters fail.
        assert.commandFailed(conn.getDB("config").clusterParameters.insert({
            _id: 'testIntClusterParameter',
            foo: 'bar',
            clusterParameterTime: {"$timestamp": {t: 0, i: 0}}
        }));
    }
}
