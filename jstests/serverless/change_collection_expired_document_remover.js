/**
 * Tests the change collection periodic remover job.
 *
 * @tags: [requires_fcv_62]
 */

(function() {
"use strict";

// For configureFailPoint.
load("jstests/libs/fail_point_util.js");
// For assertDropAndRecreateCollection.
load("jstests/libs/collection_drop_recreate.js");
// For ChangeStreamMultitenantReplicaSetTest.
load("jstests/serverless/libs/change_collection_util.js");

const getTenantConnection = ChangeStreamMultitenantReplicaSetTest.getTenantConnection;

// Sleep interval in seconds for the change collection remover job.
const kExpiredRemovalJobSleepSeconds = 5;
// Number of seconds after which the documents in change collections will be expired.
const kExpireAfterSeconds = 1;
// Number of seconds to sleep before inserting the next batch of documents in collections.
const kSleepBetweenWritesSeconds = 5;
// Millisecond(s) that can be added to the wall time to advance it marginally.
const kSafetyMarginMillis = 1;

// TODO SERVER-69115 Change to a 2-node replica set.
const replSet = new ChangeStreamMultitenantReplicaSetTest({
    nodes: 1,
    setParameter:
        {changeCollectionExpiredDocumentsRemoverJobSleepSeconds: kExpiredRemovalJobSleepSeconds}
});

const primary = replSet.getPrimary();

// TODO SERVER-69115 Uncomment this code.
// const secondary = replSet.getSecondary();

// Assert that the change collection contains all documents in 'expectedRetainedDocs' and no
// document in 'expectedDeletedDocs' for the collection 'stocksColl'.
function assertChangeCollectionDocuments(
    changeColl, stocksColl, expectedDeletedDocs, expectedRetainedDocs) {
    const collNss = `${stocksTestDb.getName()}.${stocksColl.getName()}`;
    const pipeline = (collectionEntries) => [{$match: {op: "i", ns: collNss}},
                                             {$replaceRoot: {"newRoot": "$o"}},
                                             {$match: {$or: collectionEntries}}];

    // Assert that querying for 'expectedRetainedDocs' yields documents that are exactly the same as
    // 'expectedRetainedDocs'.
    if (expectedRetainedDocs.length > 0) {
        const retainedDocs = changeColl.aggregate(pipeline(expectedRetainedDocs)).toArray();
        assert.eq(retainedDocs, expectedRetainedDocs);
    }

    // Assert that the query for any `expectedDeletedDocs` yields no results.
    if (expectedDeletedDocs.length > 0) {
        const deletedDocs = changeColl.aggregate(pipeline(expectedDeletedDocs)).toArray();
        assert.eq(deletedDocs.length, 0);
    }
}

// Returns the operation time for the provided document 'doc'.
function getDocumentOperationTime(doc) {
    const oplogEntry = primary.getDB("local").oplog.rs.findOne({o: doc});
    assert(oplogEntry);
    return oplogEntry.wall.getTime();
}

// Hard code a tenant ids such that tenants can be identified deterministically.
const stocksTenantId = ObjectId("6303b6bb84305d2266d0b779");
const citiesTenantId = ObjectId("7303b6bb84305d2266d0b779");
const notUsedTenantId = ObjectId("8303b6bb84305d2266d0b779");

// Create connections to the primary such that they have respective tenant ids stamped.
const stocksTenantConnPrimary = getTenantConnection(primary.host, stocksTenantId);
const citiesTenantConnPrimary = getTenantConnection(primary.host, citiesTenantId);

// Create a tenant connection associated with 'notUsedTenantId' such that only the tenant id exists
// in the replica set but no corresponding change collection exists. The purging job should safely
// ignore this tenant without any side-effects.
const notUsedTenantConnPrimary = getTenantConnection(primary.host, notUsedTenantId);

// TODO SERVER-69115 Uncomment this code and use tenants connections to the secondary.
/**
const stocksTenantConnSecondary = getTenantConnection(secondary.host, stocksTenantId);
const citiesTenantConnSecondary = getTenantConnection(secondary.host, citiesTenantId);
*/

// TODO SERVER-69115 Uncomment this code and fetch tenants change collection on the secondary.
/**
const stocksChangeCollectionSecondary =
stocksTenantConnSecondary.getDB("config").system.change_collection; const
citiesChangeCollectionSecondary =
citiesTenantConnSecondary.getDB("config").system.change_collection;
*/

// Enable change streams for both tenants.
replSet.setChangeStreamState(stocksTenantConnPrimary, true);
replSet.setChangeStreamState(citiesTenantConnPrimary, true);

// Verify change streams state for all tenants.
assert.eq(replSet.getChangeStreamState(stocksTenantConnPrimary), true);
assert.eq(replSet.getChangeStreamState(citiesTenantConnPrimary), true);
assert.eq(replSet.getChangeStreamState(notUsedTenantConnPrimary), false);

// Get tenants respective change collections.
const stocksChangeCollectionPrimary =
    stocksTenantConnPrimary.getDB("config").system.change_collection;
const citiesChangeCollectionPrimary =
    citiesTenantConnPrimary.getDB("config").system.change_collection;

// Set the 'expireAfterSeconds' to 'kExpireAfterSeconds'.
// TODO SERVER-69511 Use tenants connections instead of 'primary' to set 'expireAfterSeconds'.
assert.commandWorked(primary.getDB("admin").runCommand(
    {setClusterParameter: {changeStreams: {expireAfterSeconds: kExpireAfterSeconds}}}));

// Get tenants respective collections for testing.
const stocksTestDb = stocksTenantConnPrimary.getDB(jsTestName());
const citiesTestDb = citiesTenantConnPrimary.getDB(jsTestName());
const notUsedTestDb = notUsedTenantConnPrimary.getDB(jsTestName());

const stocksColl = assertDropAndRecreateCollection(stocksTestDb, "stocks");
const citiesColl = assertDropAndRecreateCollection(citiesTestDb, "cities");
const notUsedColl = assertDropAndRecreateCollection(notUsedTestDb, "notUsed");

// Wait until the remover job hangs.
let fpHangBeforeRemovingDocs = configureFailPoint(primary, "hangBeforeRemovingExpiredChanges");
fpHangBeforeRemovingDocs.wait();

// Insert 5 documents to the 'stocks' collection owned by the 'stocksTenantId' that should be
// deleted.
const stocksExpiredDocuments = [
    {_id: "aapl", price: 140},
    {_id: "dis", price: 100},
    {_id: "nflx", price: 185},
    {_id: "baba", price: 66},
    {_id: "amc", price: 185}
];

// Insert 4 documents to the 'cities' collection owned by the 'citiesTenantId' that should be
// deleted.
const citiesExpiredDocuments = [
    {_id: "toronto", area_km2: 630},
    {_id: "singapore ", area_km2: 728},
    {_id: "london", area_km2: 1572},
    {_id: "tokyo", area_km2: 2194}
];

assert.commandWorked(stocksColl.insertMany(stocksExpiredDocuments));
assertChangeCollectionDocuments(stocksChangeCollectionPrimary,
                                stocksColl,
                                /* expectedDeletedDocs */[],
                                /* expectedRetainedDocs */ stocksExpiredDocuments);

assert.commandWorked(citiesColl.insertMany(citiesExpiredDocuments));
assertChangeCollectionDocuments(citiesChangeCollectionPrimary,
                                citiesColl,
                                /* expectedDeletedDocs */[],
                                /* expectedRetainedDocs */ citiesExpiredDocuments);

// Insert 2 documents to the 'notUsed' collection such that the associated tenant becomes visible to
// the mongoD. The documents in these collections will not be consumed by the change stream.
const notUsedDocuments =
    [{_id: "cricket_bat", since_years: 2}, {_id: "tennis_racket", since_years: 2}];
assert.commandWorked(notUsedColl.insertMany(notUsedDocuments));

// All document before and inclusive this wall time will be deleted by the purging job.
const lastExpiredDocumentTime = getDocumentOperationTime(citiesExpiredDocuments.at(-1));

// Sleep for 'kSleepBetweenWritesSeconds' duration such that the next batch of inserts
// has a sufficient delay in their wall time relative to the previous batch.
sleep(kSleepBetweenWritesSeconds * 1000);

// Insert 5 documents to the 'stocks' collection owned by the 'stocksTenantId' that should not be
// deleted.
const stocksNonExpiredDocuments = [
    {_id: "wmt", price: 11},
    {_id: "coin", price: 23},
    {_id: "ddog", price: 15},
    {_id: "goog", price: 199},
    {_id: "tsla", price: 12}
];

// Insert 4 documents to the 'cities' collection owned by the 'citiesTenantId' that should not be
// deleted.
const citiesNonExpiredDocuments = [
    {_id: "dublin", area_km2: 117},
    {_id: "new york", area_km2: 783},
    {_id: "hong kong", area_km2: 1114},
    {_id: "sydney", area_km2: 12386}
];

assert.commandWorked(stocksColl.insertMany(stocksNonExpiredDocuments));
assertChangeCollectionDocuments(stocksChangeCollectionPrimary,
                                stocksColl,
                                /* expectedDeletedDocs */[],
                                /* expectedRetainedDocs */ stocksNonExpiredDocuments);

assert.commandWorked(citiesColl.insertMany(citiesNonExpiredDocuments));
assertChangeCollectionDocuments(citiesChangeCollectionPrimary,
                                citiesColl,
                                /* expectedDeletedDocs */[],
                                /* expectedRetainedDocs */ citiesNonExpiredDocuments);

// Calculate the 'currentWallTime' such that only the first batch of inserted documents
// should be expired, ie.: 'lastExpiredDocumentTime' + 'kExpireAfterSeconds' <
// 'currentWallTime' < first-non-expired-document.
const currentWallTime =
    new Date(lastExpiredDocumentTime + kExpireAfterSeconds * 1000 + kSafetyMarginMillis);
const fpInjectWallTime = configureFailPoint(
    primary, "injectCurrentWallTimeForRemovingExpiredDocuments", {currentWallTime});

// Unblock the change collection remover job such that it picks up on the injected
// 'currentWallTime'.
fpHangBeforeRemovingDocs.off();

// Wait until the remover job has retrieved the injected 'currentWallTime' and reset the first
// failpoint.
fpInjectWallTime.wait();

// Wait for a complete cycle of the TTL job.
fpHangBeforeRemovingDocs = configureFailPoint(primary, "hangBeforeRemovingExpiredChanges");
fpHangBeforeRemovingDocs.wait();

// Assert that only required documents are retained in change collections.
assertChangeCollectionDocuments(
    stocksChangeCollectionPrimary, stocksColl, stocksExpiredDocuments, stocksNonExpiredDocuments);
assertChangeCollectionDocuments(
    citiesChangeCollectionPrimary, citiesColl, citiesExpiredDocuments, citiesNonExpiredDocuments);

// TODO SERVER-69115 Uncomment this code block.
/**
// Wait for the replication to complete and assert that the expired documents also have been
//  deleted from the secondary.
replSet.awaitReplication();
assertChangeCollectionDocuments(stocksChangeCollectionSecondary,
stocksColl, stocksExpiredDocuments,stocksNonExpiredDocuments);
assertChangeCollectionDocuments(citiesChangeCollectionSecondary,
citiesColl, citiesExpiredDocuments, citiesNonExpiredDocuments);
*/

fpHangBeforeRemovingDocs.off();

replSet.stopSet();
})();
