/* eslint no-use-before-define: "warn" */
const fs = require("fs");
const {  ethers } = require("hardhat");
const {getFileNames} = require('./utils')

const ADDR_BYTES = 20;
const SMALL_NUM_BYTES = 1;
const MID_NUM_BYTES = 3;
const BATCH_TYPE_BYTES = 1;
const BITMASK_BYTES = 13;
const GAS_COST_BYTE = 16;

const stringifyBigIntReplacer = (key, value) => {
    return typeof value === 'bigint' ? value.toString(2) : value;
};


const getMaxGroupFromBatch = (batch) => {

    let maxGroup = {
        numItems: 0,
        items: [],
        karma: ''
    }
    for (let karma of Object.keys(batch)) {

        let items = batch[karma];
        if (items.length > maxGroup.numItems) {
            maxGroup.numItems = items.length;
            maxGroup.items = items;
            maxGroup.karma = karma;
        }

    }
    return maxGroup

}

const getStats = async (dirPathRead, dirPathWrite) => {

    const files = getFileNames(dirPathRead)
    const stats = {
        largestGroupRepeating: {
            filename: '',
            karma: '',
            numItems: 0,
            items: []
        }
    };
    for (let file of files) {
        let data = fs.readFileSync(`${dirPathRead}/${file}`)
        data = JSON.parse(data.toString('utf-8'));
        let fileName = file.replace('.json', '')


        for (let batch of data.repeatingGrouped) {
            if(Object.keys(batch).length === 0) continue;

            let largestGroupBatch = getMaxGroupFromBatch(batch);
            if (largestGroupBatch.numItems > stats.largestGroupRepeating.numItems) {
                stats.largestGroupRepeating = largestGroupBatch;
                stats.largestGroupRepeating.filename = fileName;
            }

        }
    }

    console.log("stats", stats)


    fs.writeFileSync(`${dirPathWrite}/general.json`, JSON.stringify(stats))


}

const indexAddresses = (dirPathRead, dirPathWrite, reindex=false) => {

    let indexPath = `${dirPathWrite}/addressIndex.json`;
    if(fs.existsSync(indexPath) && !reindex) {
        let data = fs.readFileSync(indexPath)
        return JSON.parse(data.toString('utf-8'));
    }

    const files = getFileNames(dirPathRead)
    const index = {

    };
    for (let file of files) {
        let data = fs.readFileSync(`${dirPathRead}/${file}`)
        console.log(`indexing file... ${file}`)
        data = JSON.parse(data.toString('utf-8'));

        for(let item of data) {
            if(!(item.address in index)) {
                index[item.address] = Object.keys(index).length
            }
        }
        console.log(`file ${file} indexed successfully!`)
    }
    fs.writeFileSync(`${dirPathWrite}/addressIndex.json`, JSON.stringify(index))
    return index;
}

const makeGroups = (dirPathRead, dirPathWrite, index) => {
    let subdir = `${dirPathWrite}/groups`

    const files = getFileNames(dirPathRead)
    const groupStatsMap = {};
    let groupId = 0;
    for (let file of files) {
        let data = fs.readFileSync(`${dirPathRead}/${file}`)
        data = JSON.parse(data.toString('utf-8'));
        let groups = {

        };
        for(let item of data) {
            let addrId = index[item.address];
            if(!(item.karma in groups)) {
                groups[item.karma] = [addrId]
            } else {
                groups[item.karma].push(addrId)
            }
        }
        for(let karma of Object.keys(groups)) {
            if (groups[karma].length > 1) {
                groupStatsMap[groupId] = {
                    karma: karma,
                    items: groups[karma],
                    numItems: groups[karma].length
                }
                groupId++;
            }
        }

    }

    fs.writeFileSync(`${subdir}/allGroups.json`, JSON.stringify(groupStatsMap))
}


const findItemsInGroupRegistry = (karma, groupRegistry, groupItems) => {

    let groups = {
        [karma]: {
            items: [],
            groupBitmap: BigInt(0),
            groupSize: groupRegistry[karma].length,
            numItems: 0
        }
    };

    let notFoundItems = [];
    // prioritize the same karma first
    for(let item of groupItems) {

        let itemId = groupRegistry[karma].indexOf(item)

        if(itemId >= 0) {
            groups[karma]['items'].push({item, itemId})
            groups[karma]['groupBitmap'] |= (BigInt(1) << BigInt(itemId))
        } else {
            notFoundItems.push(item);
        }

    }
    groups[karma]['numItems'] = groups[karma]['items'].length;


    for(let regKarma in groupRegistry) {
        if(!groupRegistry.hasOwnProperty(regKarma)) continue;
        if(regKarma === karma) continue;
        if(notFoundItems.length === 0) break;

        for(let item of notFoundItems) {

            let itemId = groupRegistry[regKarma].indexOf(item)

            if(itemId >= 0) {
                if(!(regKarma in groups)) {
                    groups[regKarma] = {
                        items: [],
                        groupBitmap: BigInt(0),
                        groupSize: groupRegistry[regKarma].length,
                        numItems: 0
                    };
                }
                groups[regKarma]['items'].push({item, itemId})
                let itemIdNotFound = notFoundItems.indexOf(item);
                notFoundItems.splice(itemIdNotFound, 1);
                groups[regKarma]['groupBitmap'] |= (BigInt(1) << BigInt(itemId))
            }
        }

        if(regKarma in groups) {
            groups[regKarma]['numItems'] = groups[regKarma]['numItems'].length
        }

    }
    return groups;


};

const makeRepeatingGroupStatsGlobalRegistry = (repeatingGroups, globalGroupRegistry, writePath) => {

    let distStats = {

    };

    for (let groupId in repeatingGroups) {

        if (!repeatingGroups.hasOwnProperty(groupId)) continue;
        let filename = repeatingGroups[groupId].filename;
        let groupFileIndex = parseInt(filename.split('_')[1]);

        if(groupFileIndex === 1) continue;

        let items = repeatingGroups[groupId].items;
        let karma = repeatingGroups[groupId].karma;

        let groupRegistryIndex = (groupFileIndex - 1).toString()
        let groupRegistryPrevDist = globalGroupRegistry[groupRegistryIndex]

        if(!(karma in groupRegistryPrevDist)) {
            continue;
        }

        let groupedItems = findItemsInGroupRegistry(karma, groupRegistryPrevDist, items);

        if(!(filename in distStats)) {
            distStats[filename] = {
              [groupId]: groupedItems
            };
        } else {
            distStats[filename][groupId] = groupedItems;
        }
    }
    fs.writeFileSync(`${writePath}/allDistStats.json`, JSON.stringify(distStats, stringifyBigIntReplacer));


};

const sortRepeatingGroupsBySizeAndAddBitmaps = (repeatingGroups, writePath) => {

  const filteredGroups = [];
  const bitmapStats = [];

  for (let groupId in repeatingGroups) {

      if (!repeatingGroups.hasOwnProperty(groupId)) continue;
      if(parseInt(repeatingGroups[groupId].filename.split('_')[1]) === 1) continue;

      let items = repeatingGroups[groupId].items;

      items.sort((first, second) => first - second);
      let startIndex = items[0];
      let endIndex = items[items.length - 1];
      let bitmapSize = endIndex - startIndex;
      let bitmap = BigInt(0)

      items = items.map(item => item - startIndex);
      for(let item of items) {
          bitmap = bitmap | (BigInt(1) << BigInt(item))
      }
      repeatingGroups[groupId].bitmapSize = bitmapSize;
      repeatingGroups[groupId].groupId = groupId;
      repeatingGroups[groupId].startIndex = startIndex;
      repeatingGroups[groupId].endIndex = endIndex;
      filteredGroups.push(repeatingGroups[groupId])
      bitmapStats.push({
          numItems: repeatingGroups[groupId].numItems,
          groupId,
          startIndex,
          endIndex,
          bitmapSize,
          bitmap
      })
  }

  filteredGroups.sort((first, second) => second.numItems - first.numItems);
  bitmapStats.sort((first, second) => second.bitmapSize - first.bitmapSize);

  fs.writeFileSync(`${writePath}/sortedRepeatingGroups.json`, JSON.stringify(filteredGroups));




  fs.writeFileSync(`${writePath}/bitmapStats.json`, JSON.stringify(bitmapStats, stringifyBigIntReplacer));

  let bitmapAnalysisSample = bitmapStats.map(item => item.bitmap);
  let bitmapsLargest20 = bitmapAnalysisSample.slice(0, 20);
  let bitmapsSmallest20 = bitmapAnalysisSample.slice(bitmapAnalysisSample.length - 20);
  let bitmapMid = Math.round(bitmapAnalysisSample.length / 2);
  let bitmapsMedium20 = bitmapAnalysisSample.slice(bitmapMid, bitmapMid + 20);

  fs.writeFileSync(`${writePath}/bitmapsLargest20.json`, JSON.stringify(bitmapsLargest20, stringifyBigIntReplacer))
  fs.writeFileSync(`${writePath}/bitmapsSmallest20.json`, JSON.stringify(bitmapsSmallest20, stringifyBigIntReplacer))
  fs.writeFileSync(`${writePath}/bitmapsMedium20.json`, JSON.stringify(bitmapsMedium20, stringifyBigIntReplacer))

};


const addAddressInGroup = (item, groups, addressIndex) => {
    let addrId = addressIndex[item.address]
    if(!(item.karma in groups)) {
        groups[item.karma] = [addrId]
    } else {
        groups[item.karma].push(addrId)
    }
}

const makeGroupsWithRepeatingUsersOnly = (dirPathRead, dirPathWrite) => {
    let subdir = `${dirPathWrite}/groups`

    const files = getFileNames(dirPathRead)
    const groupStatsMap = {};
    const addressIndex = {};
    let groupId = 0;
    for (let file of files) {
        let data = fs.readFileSync(`${dirPathRead}/${file}`)
        data = JSON.parse(data.toString('utf-8'));
        let groups = {};
        for(let item of data) {

            if(!(item.address in addressIndex)) {

                addressIndex[item.address] = Object.keys(addressIndex).length;

                if(file === files[0]) {
                    addAddressInGroup(item, groups, addressIndex);
                }
            } else {
                addAddressInGroup(item, groups, addressIndex);
            }

        }

        for(let karma of Object.keys(groups)) {
            if (groups[karma].length > 1) {
                groupStatsMap[groupId] = {
                    karma: karma,
                    items: groups[karma],
                    numItems: groups[karma].length,
                    filename: file
                }
                groupId++;
            }
        }

    }

    fs.writeFileSync(`${subdir}/groupsWithOnlyRepeatingUsers.json`, JSON.stringify(groupStatsMap))
    fs.writeFileSync(`${subdir}/addressIndexFromGrouping.json`, JSON.stringify(addressIndex))

}


const addAddressInGroupGlobal = (item, groups, addressIndex) => {
    let addrId = addressIndex[item.address]
    if(!(item.karma in groups)) {
        groups[item.karma] = [addrId]
    } else {
        if(!groups[item.karma].includes(addrId)) {
            groups[item.karma].push(addrId)
        }
    }
}

const makeGroupsWithRepeatingUsersWithGroupRegistry = (dirPathRead, dirPathWrite) => {
    let subdir = `${dirPathWrite}/groups`

    const files = getFileNames(dirPathRead)
    const groupStatsMap = {};
    const addressIndex = {};
    const groupRegistry = {}; // karma: [addrIds]
    const globalGroupRegistry = {};
    let groupId = 0;
    for (let file of files) {
        let data = fs.readFileSync(`${dirPathRead}/${file}`)
        data = JSON.parse(data.toString('utf-8'));
        let groups = {};
        for(let item of data) {

            if(!(item.address in addressIndex)) {

                addressIndex[item.address] = Object.keys(addressIndex).length;

                if(file === files[0]) {
                    addAddressInGroup(item, groups, addressIndex);
                    addAddressInGroupGlobal(item, groupRegistry, addressIndex);
                }
            } else {
                addAddressInGroup(item, groups, addressIndex);
                addAddressInGroupGlobal(item, groupRegistry, addressIndex);
            }

        }

        for(let karma of Object.keys(groups)) {
            if (groups[karma].length > 1) {
                groupStatsMap[groupId] = {
                    karma: karma,
                    items: groups[karma],
                    numItems: groups[karma].length,
                    filename: file
                }
                groupId++;
            }
        }
        let fileIndex = file.split("_")[1];

        globalGroupRegistry[fileIndex] = JSON.parse(JSON.stringify(groupRegistry));



    }

    fs.writeFileSync(`${subdir}/groupsWithOnlyRepeatingUsers.json`, JSON.stringify(groupStatsMap))
    fs.writeFileSync(`${subdir}/addressIndexFromGrouping.json`, JSON.stringify(addressIndex))
    fs.writeFileSync(`${subdir}/globalGroupRegistry.json`, JSON.stringify(globalGroupRegistry))

}




const compareGroups = (group1, group2) => {
    let result = {
        duplicate: false,
        subset: false,
        groupId: 0
    }
    // if (group1.karma !== group2.karma) {
    //     return result;
    // }

    let duplicate = true;

    let smallerGroup;
    let largerGroup;

    if(group1.items > group2.items) {
        smallerGroup = group2;
        largerGroup = group1;
    } else {
        smallerGroup = group1;
        largerGroup = group2;
    }

    for (let item of smallerGroup.items) {
        if(!largerGroup.items.includes(item)) {
            duplicate = false;
            break;
        }
    }
    result.duplicate = duplicate;

    if(duplicate) {
        if(smallerGroup.items.length !== largerGroup.items.length) {
            result.subset = true;
        }
    }
    return result;

};

const findRepeatingGroups = (writePath, groups) => {

    let numGroups = Object.keys(groups).length;
    let repeatingGroups = {

    };
    for(let i = 0; i < numGroups; i++) {
        let iStr = i.toString();

        let groupI = groups[iStr];

        for(let j = i + 1; j < numGroups; j++) {
            let jStr = j.toString();
            let groupJ = groups[jStr];
            let result = compareGroups(groupI, groupJ);
            if(result.duplicate) {

                result.groupId = jStr;
                if(i in repeatingGroups) {
                    repeatingGroups[iStr].push(result)
                } else {
                    repeatingGroups[iStr] = [result]
                }
            }


        }

    }

    fs.writeFileSync(`${writePath}`, JSON.stringify(repeatingGroups))

}

const makeGroupsByMonth = (groups) => {

    const groupsByMonth = {

    };

    for (let groupId in groups) {
        if(!groups.hasOwnProperty(groupId)) continue;

        let group = groups[groupId];
        group.groupId = groupId;
        let filenameId = group.filename.split('_')[1];
        if(filenameId in groupsByMonth) {
            groupsByMonth[filenameId].push(group)
        } else {
            groupsByMonth[filenameId] = [group]
        }
    }


    return groupsByMonth;

}


const findSubsetsForEachGroup = (writePath, groups) => {

    const groupsByMonth = makeGroupsByMonth(groups);

    fs.writeFileSync(`${writePath}/groupsByMonth.json`, JSON.stringify(groupsByMonth))



    let distIds = Object.keys(groupsByMonth);
    distIds.sort((first, second) => parseInt(first) - parseInt(second));

    let subsets = {

    };

    for (let distId of distIds.slice(1)) {

        for(let distId2 of distIds) {
            if(distId === distId2) {
                break;
            }

            let groupsOld = groupsByMonth[distId2];
            let groupsNew = groupsByMonth[distId];

            for(let i = 0; i < groupsNew.length; i++) {
                let groupNew = groupsNew[i];
                subsets[groupNew.groupId] = {
                    repeats: [],
                    notIncluded: []
                }
                let included = []

                for(let j = 0; j < groupsOld.length; j++) {
                    let groupOld = groupsOld[j];

                    let grSubsets = {
                        groupId: groupOld.groupId,
                        items: [],
                        numItems: 0
                    }
                    for(let item of groupNew.items) {
                        if (groupOld.items.includes(item)) {
                            grSubsets.items.push(item);
                            grSubsets.numItems++;

                            included.push(item);
                        }
                    }
                    if(grSubsets.numItems > 0) {
                        subsets[groupNew.groupId].repeats.push(grSubsets);
                    }
                }

                for(let item of groupNew.items) {
                    if(!included.includes(item)) {
                        subsets[groupNew.groupId].notIncluded.push(item);
                    }
                }

            }

        }

    }

    fs.writeFileSync(`${writePath}/groupSubsets.json`, JSON.stringify(subsets))



};


const groupItems = (items, addressMap= null) => {

    let groupedItems = {};
    for(let item of items) {
        let address = item.address;
        if(addressMap) {
            address = addressMap(address);
        }
        if (item.karma in groupedItems) {
            groupedItems[item.karma].push(address)
        } else {
            groupedItems[item.karma] = [address]
        }
    }

    let singles = {}
    let grouped = {}
    for(let karma in groupedItems) {
        if(groupedItems[karma].length === 1) {
            let addr = groupedItems[karma][0]
            singles[addr] = karma;
        } else {
            grouped[karma] = groupedItems[karma]
        }
    }
    return {
        singles,
        grouped
    }

}


const getGroupsForRepeatingUsersPerKarma = (karma, items) => {
    const groups = {

    };
    items.sort();

    for(let item of items) {
        let groupId = Math.floor(item/100);
        let bitmapPosition = item % 100;
        if (groupId in groups) {
            groups[groupId].items.push(item);
            groups[groupId].bitmap = groups[groupId].bitmap | BigInt(1) << BigInt(bitmapPosition);
        } else {
            groups[groupId] = {
                items: [item],
                bitmap: BigInt(1) << BigInt(bitmapPosition)
            }
        }
    }
    return groups;

}


const isSmallNum = (num) => {
    return parseInt(num) < 128;
}

const calculateStats = (classifiedItems) => {

    // newSingles = 1 byte + (20 bytes + 1 or 3 bytes) * numAddresses
    // newGrouped = 1 byte + (1 or 3 bytes + 1 or 3 bytes + numAddr * 20 bytes) * numGroups
    // repeatingSingles = 1 byte + (1 or 3 bytes + 1 or 3 bytes) * numAddresses
    // repeatingMasks = 1 byte + (1 or 3 bytes + 1 or 3 bytes + (1 or 3 bytes + 13 bytes) * numGroupsInKarma) * numGroups

    // newSingles
    let stats = {
        gasCosts: {
            newSingles: 0,
            newGrouped: 0,
            repeatedSingles: 0,
            repeatedMasks: 0
        },
        byteSizes: {
            newSingles: 0,
            newGrouped: 0,
            repeatedSingles: 0,
            repeatedMasks: 0
        }
    }

    // new singles
    for(let addr in classifiedItems.newSingles) {
        let byteSize = 0;
        if(isSmallNum(classifiedItems.newSingles[addr])) {
            byteSize += SMALL_NUM_BYTES
        } else {
            byteSize += MID_NUM_BYTES
        }
        byteSize += ADDR_BYTES;
        stats.byteSizes.newSingles += byteSize;
    }

    // new grouped
    for(let karma in classifiedItems.newGrouped) {
        let byteSize = 0;
        let items = classifiedItems.newGrouped[karma];
        if(isSmallNum(karma)) {
            byteSize += SMALL_NUM_BYTES;
        } else {
            byteSize += MID_NUM_BYTES;
        }

        if(isSmallNum(items.length)) {
            byteSize += SMALL_NUM_BYTES;
        } else {
            byteSize += MID_NUM_BYTES;
        }

        byteSize += ADDR_BYTES * items.length;
        stats.byteSizes.newGrouped += byteSize
    }


    // repeating singles
    for(let addrId in classifiedItems.repeatedSingles) {
        let byteSize = 0;
        if(isSmallNum(classifiedItems.repeatedSingles[addrId])) {
            byteSize += SMALL_NUM_BYTES
        } else {
            byteSize += MID_NUM_BYTES
        }

        if(isSmallNum(addrId)) {
            byteSize += SMALL_NUM_BYTES
        } else {
            byteSize += MID_NUM_BYTES
        }

        stats.byteSizes.repeatedSingles += byteSize;
    }

    // repeating masks
    for(let karma in classifiedItems.repeatedMasks) {
        let byteSize = 0;

        // karma
        if(isSmallNum(karma)) {
            byteSize += SMALL_NUM_BYTES
        } else {
            byteSize += MID_NUM_BYTES
        }

        // numGroups
        if(isSmallNum(Object.keys(classifiedItems.repeatedMasks[karma]).length)) {
            byteSize += SMALL_NUM_BYTES
        } else {
            byteSize += MID_NUM_BYTES
        }

        for(let groupId in classifiedItems.repeatedMasks[karma]) {
            // groupId
            if(isSmallNum(groupId)) {
                byteSize += SMALL_NUM_BYTES
            } else {
                byteSize += MID_NUM_BYTES
            }

            // bitMask
            byteSize += BITMASK_BYTES
        }

        stats.byteSizes.repeatedMasks += byteSize;
    }

    for (let key in stats.byteSizes) {
        if(stats.byteSizes[key] > 0) {
            stats.byteSizes[key] += 1;
            stats.gasCosts[key] = GAS_COST_BYTE * stats.byteSizes[key];
        }
    }

    return stats
}


const getNaiveGasCosts = (dirPathRead, writeFilePath) => {

    const files = getFileNames(dirPathRead)
    const stats = {
        totalByteSize: 0,
        totalGasCost: 0
    }

    for (let file of files) {
        let data = fs.readFileSync(`${dirPathRead}/${file}`)
        data = JSON.parse(data.toString('utf-8'));
        let byteSize = 0;
        for(let item of data) {
            if(isSmallNum(item.karma)) {
                byteSize += SMALL_NUM_BYTES
            } else {
                byteSize += MID_NUM_BYTES
            }
            byteSize += ADDR_BYTES;
        }

        stats[file] = {
            byteSize: byteSize,
            gasCost: byteSize * GAS_COST_BYTE
        }

        stats['totalByteSize'] += stats[file]['byteSize']
        stats['totalGasCost'] += stats[file]['gasCost']
    }

    fs.writeFileSync(writeFilePath, JSON.stringify(stats))

};


const getCompressedGasCosts = (dirPathRead, filePathWrite) => {
    // TODO
    let subdir = `${dirPathWrite}/stats`

    const files = getFileNames(dirPathRead)
    const addressIndex = {};
    const stats = {
        global: {
            gasCosts: {
                newSingles: 0,
                newGrouped: 0,
                repeatedSingles: 0,
                repeatedMasks: 0
            },
            byteSizes: {
                newSingles: 0,
                newGrouped: 0,
                repeatedSingles: 0,
                repeatedMasks: 0
            }
        },
        dists: {

        }

    }

    for (let file of files) {
        let data =  fs.readFileSync(`${dirPathRead}/${file}`)
        data = JSON.parse(data.toString('utf-8'));
        let classifiedItems = {
            newSingles: {

            },
            newGrouped: {

            },
            repeatedSingles: {

            },
            repeatedMasks: {

            }
        };
        let newItems = [];
        let repeatingItems = [];
        for(let item of data) {
            if(!(item.address in addressIndex)) {
                newItems.push(item);
                addressIndex[item.address] = Object.keys(addressIndex).length;
            } else {
                repeatingItems.push(item);
            }
        }


        let {singles, grouped} = groupItems(newItems)
        classifiedItems.newSingles = singles;
        classifiedItems.newGrouped = grouped;


        let addressMap = (addr) => addressIndex[addr];
        let res = groupItems(repeatingItems, addressMap)
        classifiedItems.repeatedSingles = res.singles;

        for(let karma in res.grouped) {
            let items = res.grouped[karma].slice();
            classifiedItems.repeatedMasks[karma] = getGroupsForRepeatingUsersPerKarma(karma, items);
        }

        let distStats = calculateStats(classifiedItems);
        let distName = file.replace('.json', '')
        stats.dists[distName] = distStats

        for (let key in distStats.byteSizes) {
            stats.global.byteSizes[key] += distStats.byteSizes[key]
            stats.global.gasCosts[key] += distStats.gasCosts[key]
        }

        fs.writeFileSync(`${subdir}/${file}`, JSON.stringify(classifiedItems, stringifyBigIntReplacer))

    }

    fs.writeFileSync(`${subdir}/statsGlobal.json`, JSON.stringify(stats))


};

const makeStatsWithCosts = (dirPathRead, dirPathWrite) => {

    let subdir = `${dirPathWrite}/stats`

    const files = getFileNames(dirPathRead)
    const addressIndex = {};
    const stats = {
        global: {
            gasCosts: {
                newSingles: 0,
                newGrouped: 0,
                repeatedSingles: 0,
                repeatedMasks: 0
            },
            byteSizes: {
                newSingles: 0,
                newGrouped: 0,
                repeatedSingles: 0,
                repeatedMasks: 0
            }
        },
        dists: {

        }

    }

    for (let file of files) {
        let data =  fs.readFileSync(`${dirPathRead}/${file}`)
        data = JSON.parse(data.toString('utf-8'));
        let classifiedItems = {
            newSingles: {

            },
            newGrouped: {

            },
            repeatedSingles: {

            },
            repeatedMasks: {

            }
        };
        let newItems = [];
        let repeatingItems = [];
        for(let item of data) {
            if(!(item.address in addressIndex)) {
                newItems.push(item);
                addressIndex[item.address] = Object.keys(addressIndex).length;
            } else {
                repeatingItems.push(item);
            }
        }


        let {singles, grouped} = groupItems(newItems)
        classifiedItems.newSingles = singles;
        classifiedItems.newGrouped = grouped;


        let addressMap = (addr) => addressIndex[addr];
        let res = groupItems(repeatingItems, addressMap)
        classifiedItems.repeatedSingles = res.singles;

        for(let karma in res.grouped) {
            let items = res.grouped[karma].slice();
            classifiedItems.repeatedMasks[karma] = getGroupsForRepeatingUsersPerKarma(karma, items);
        }

        let distStats = calculateStats(classifiedItems);
        let distName = file.replace('.json', '')
        stats.dists[distName] = distStats

        for (let key in distStats.byteSizes) {
            stats.global.byteSizes[key] += distStats.byteSizes[key]
            stats.global.gasCosts[key] += distStats.gasCosts[key]
        }

        fs.writeFileSync(`${subdir}/${file}`, JSON.stringify(classifiedItems, stringifyBigIntReplacer))

    }

    fs.writeFileSync(`${subdir}/statsGlobal.json`, JSON.stringify(stats))


};



const main = async () => {
    console.log("Making group stats...");

    const dirPathBricksRead = "reddit-data-parsed/bricks";
    const dirPathBricksJson = 'reddit-data-json/bricks'
    const dirPathBricksWrite = "reddit-data-stats/bricks";

    const dirPathMoonsRead = "reddit-data-parsed/moons";
    const dirPathMoonsWrite = "reddit-data-stats/moons";

    console.log("Getting naive gas costs...")
    getNaiveGasCosts(dirPathBricksJson, `${dirPathBricksWrite}/stats/naiveGasCosts.json`)

    // TODO:
    console.log("Getting compressed gas costs...")
    getCompressedGasCosts(dirPathBricksJson, `${dirPathBricksWrite}/stats/naiveGasCosts.json`)


    console.log("Getting naive vs compressed stats and savings...")
    getNaiveVsCompressedGasCosts();

    // console.log("Making bricks stats...")
    // await getStats(dirPathBricksRead, dirPathBricksWrite);
    //
    // console.log("Making address index...")
    // let index = indexAddresses(dirPathBricksJson, dirPathBricksWrite);
    // console.log("Address index created...")
    // console.log("Making groups...")
    // makeGroups(dirPathBricksJson, dirPathBricksWrite, index);
    // console.log("Groups created...")
    // console.log("Making moons stats...")
    // await getStats(dirPathMoonsRead, dirPathMoonsWrite);
    //
    // console.log("Making groups from repeating users only...")
    // makeGroupsWithRepeatingUsersOnly(dirPathBricksJson, dirPathBricksWrite);
    // makeGroupsWithRepeatingUsersWithGroupRegistry(dirPathBricksJson, dirPathBricksWrite);

    // const repeatingGroupsPath = `${dirPathBricksWrite}/groups/groupsWithOnlyRepeatingUsers.json`
    // const repeatingGroups = JSON.parse(fs.readFileSync(repeatingGroupsPath, 'utf-8'))
    //
    // const globalGroupRegistryPath = `${dirPathBricksWrite}/groups/globalGroupRegistry.json`
    // const globalGroupRegistry = JSON.parse(fs.readFileSync(globalGroupRegistryPath, 'utf-8'))
    //
    // console.log("Making group registry stats")
    // makeRepeatingGroupStatsGlobalRegistry(repeatingGroups, globalGroupRegistry, `${dirPathBricksWrite}/groupRegistryStats`);
    //
    // console.log("Sorting repeating groups...")
    // sortRepeatingGroupsBySizeAndAddBitmaps(repeatingGroups, `${dirPathBricksWrite}/groups`);

    // const groupsPathBricks = "reddit-data-stats/bricks/groups/groupsWithOnlyRepeatingUsers.json"
    // const repeatingGroupsPathBricks = "reddit-data-stats/bricks/groups/repeatingGroups.json"
    // const groupsBricks = JSON.parse(fs.readFileSync(groupsPathBricks, 'utf-8'));
    // findRepeatingGroups(repeatingGroupsPathBricks, groupsBricks);

    //
    // console.log("Finding group subsets...")
    // findSubsetsForEachGroup('reddit-data-stats/bricks/groups', groupsBricks)

    //
    //
    // console.log("Making bricks stats with costs...")
    // makeStatsWithCosts(dirPathBricksJson, dirPathBricksWrite)


};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });