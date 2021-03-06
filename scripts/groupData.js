/* eslint no-use-before-define: "warn" */
const fs = require("fs");
const {readData, writeData, getBitmapStats, getByteSizeForRepeatingGroup, getBitmapStatsClusters, isSmallNum, groupAddresses} = require('./utils')
const {dataDirs, getGroupBitKeys} = require('./consts')

const groupByKarma = (data) => {
    const amountGroups = {};
    for (let item of data) {

        if(amountGroups[item.karma]) {
            amountGroups[item.karma].push(item.addrOrId)
        } else {
            amountGroups[item.karma] = [item.addrOrId]
        }
    }

    // get amount groups with more than 1 item in the group
    const filteredAmountGroups = {};
    const singles = {};
    for (let karma of Object.keys(amountGroups)) {
        if (amountGroups[karma].length > 1) {
            filteredAmountGroups[karma] = amountGroups[karma];
        } else {
            let addrOrId = amountGroups[karma][0]
            singles[addrOrId] = karma;
        }
    }

    return {groups: filteredAmountGroups, singles };
}

const filterNewAndRepeatingItems = (data, index) => {

    const newItems = [];
    const repeatingItems = [];

    for (let item of data) {

        if(item.address in index) {
            repeatingItems.push({
                addrOrId: index[item.address],
                karma: item.karma
            })
        } else {
            newItems.push({
                addrOrId: item.address,
                karma: item.karma
            })
            index[item.address] = Object.keys(index).length
        }

    }
    return {
        newItems,
        repeatingItems
    }

}



const setGroupValue = (data, groupId, key, value) => {
    if(groupId in data) {
        data[groupId][key] = value;
    } else {
        data[groupId] = {
            [key]: value
        }
    }
}


const groupNewSingles = (data, singles) => {
    for(let addr in singles) {
        let karma = singles[addr];
        let karmaSm = isSmallNum(karma);
        let groupId = getBitGroupId([karmaSm, 0, 0, 1])
        setGroupValue(data, groupId, addr, karma);
    }
}

const groupNewGroups = (data, groups) => {
    for (let karma in groups) {

        let addrs = groups[karma];
        let addrsLen = addrs.length;
        let karmaSm = isSmallNum(karma);
        let addrsLenSm = isSmallNum(addrsLen);

        let groupId = getBitGroupId([addrsLenSm, 0, karmaSm, 0, 1, 1])
        setGroupValue(data, groupId, karma, addrs);

    }
};

const groupRepeatingSingles = (data, singles) => {
    for (let addr in singles) {
        let karma = singles[addr];
        let addrSm = isSmallNum(addr);
        let karmaSm = isSmallNum(karma);

        let groupId = getBitGroupId([addrSm, karmaSm, 1, 0, 1])
        setGroupValue(data, groupId, addr, karma);

    }
};

const groupDataNative = (dataNew, dataRepeating) => {
    // small = number that can be represented with 1 byte
    // med = number that can be represented with more than 1 byte

    const data = {}

    groupNewSingles(data, dataNew.singles);
    groupNewGroups(data, dataNew.groups);
    groupRepeatingSingles(data, dataRepeating.singles)


    for (let karma in dataRepeating.groups) {
        let addrs = dataRepeating.groups[karma];
        let karmaSm = isSmallNum(karma);
        let addrsSm = [];
        let addrsMd = []
        for (let addr of addrs) {
            if(isSmallNum(addr)) {
                addrsSm.push(addr);
            } else {
                addrsMd.push(addr);
            }
        }

        if(addrsSm.length === 1) {
            // it is cheaper to classify this entity as repeated single rather than group
            let addrId = addrsSm.pop();
            let groupId = getBitGroupId([1, karmaSm, 1, 0, 1]);
            setGroupValue(data, groupId, addrId, karma);
        }

        if(addrsMd.length === 1) {
            // it is cheaper to classify this entity as repeated single rather than group
            let addrId = addrsMd.pop();
            let groupId = getBitGroupId([0 ,karmaSm, 1, 0, 1]);
            setGroupValue(data, groupId, addrId, karma);
        }

        setAsRepeatingGrouped(data, karma, karmaSm, addrsSm, addrsMd);



    }

    return data;

};


const groupDataBitmaps = (dataNew, dataRepeating) => {
    // small = number that can be represented with 1 byte
    // med = number that can be represented with more than 1 byte

    const data = {}

    groupNewSingles(data, dataNew.singles);
    groupNewGroups(data, dataNew.groups);
    groupRepeatingSingles(data, dataRepeating.singles)

    for (let karma in dataRepeating.groups) {
        let addrs = dataRepeating.groups[karma];
        let karmaSm = isSmallNum(karma);
        let {addrsSm, addrsMd} = groupAddresses(addrs);


        if(addrsSm.length === 1) {
            // it is cheaper to classify this entity as repeated single rather than group
            let addrId = addrsSm.pop();
            let groupId = getBitGroupId([1, karmaSm, 1, 0, 1]);
            setGroupValue(data, groupId, addrId, karma);
        }

        if(addrsMd.length === 1) {
            // it is cheaper to classify this entity as repeated single rather than group
            let addrId = addrsMd.pop();
            let groupId = getBitGroupId([0, karmaSm, 1, 0, 1]);
            setGroupValue(data, groupId, addrId, karma);
        }

        if((addrsSm.length + addrsMd.length) > 3) {
            let bitmapStats = getBitmapStats(karma, addrs, 'native');
            let costsAddrSmall = getByteSizeForRepeatingGroup(karma, addrsSm, 'native');
            let costsAddrMed = getByteSizeForRepeatingGroup(karma, addrsMd, 'native');
            if(bitmapStats.byteSize < costsAddrMed + costsAddrSmall) {
                setAsRepeatingGroupedBitmap(data, karma, karmaSm, bitmapStats)
            } else {
                setAsRepeatingGrouped(data, karma, karmaSm, addrsSm, addrsMd)
            }
        } else {
            setAsRepeatingGrouped(data, karma, karmaSm, addrsSm, addrsMd)
        }


    }

    return data;

}


const testGroupDataBitmapsClustered = (dataNew, dataRepeating) => {
    const data = {repeating: {}, totalGasCost: 0, totalGasCostBitmap: 0, totalGasCostNative: 0, totalHybridGasCost: 0}

    for (let karma in dataRepeating.groups) {
        let addrs = dataRepeating.groups[karma];
        data['repeating'][karma] = getBitmapStatsClusters(karma, addrs, 'native');
        data.totalGasCost += data['repeating'][karma].gasCostMin;
        data.totalGasCostBitmap += data['repeating'][karma].bitmapGasCost;
        data.totalGasCostNative += data['repeating'][karma].nativeGasCost;
        data.totalHybridGasCost += data['repeating'][karma].hybridGasCostMin;

    }

    data.savingsVsBitmap = data.totalGasCostBitmap - data.totalGasCost;
    data.savingsVsNative = data.totalGasCostNative - data.totalGasCost;

    data.hybridSavingVsBitmap = data.totalGasCostBitmap - data.totalHybridGasCost;
    data.hybridSavingVsNative = data.totalGasCostNative - data.totalHybridGasCost;

    return data;
}

const getBitGroupId = (inputs) => {
    let bitmask = '';
    for(let input of inputs) {
        let inputBit = input ? '1' : '0';
        bitmask = `${bitmask}${inputBit}`
    }

    bitmask = bitmask.padStart(8, "0");

    return bitmask;
}

const setAsRepeatingGrouped = (data, karma, karmaSm, addrsSm, addrsMd) => {
    let addrsSmLenSm = isSmallNum(addrsSm.length);
    let addrsMdLenSm = isSmallNum(addrsMd.length);

    if(addrsSm.length) {
        let groupId = getBitGroupId([addrsSmLenSm, 1, karmaSm, 1, 1, 1])
        setGroupValue(data, groupId, karma, addrsSm)
    }

    if (addrsMd.length) {
        let groupId = getBitGroupId([addrsMdLenSm, 0, karmaSm, 1, 1, 1])
        setGroupValue(data, groupId, karma, addrsMd)
    }

}


const setAsRepeatingGroupedBitmap = (data, karma, karmaSm, bitmapStats) => {
    let startIdSm = isSmallNum(bitmapStats.startId);
    let rangeSm = isSmallNum(bitmapStats.range);
    let headerSm = isSmallNum(bitmapStats.headerBytes)

    let groupId = getBitGroupId([1, startIdSm, rangeSm, headerSm, karmaSm, 1, 1, 1]);
    setGroupValue(data, groupId, karma, bitmapStats)
}


const group = (data, encType='rlp') => {

    let index = {};
    let grouped = {};
    let totalSavings = {
        savingsVsBitmap: 0,
        savingsVsNative: 0,
        hybridSavingVsBitmap: 0,
        hybridSavingVsNative: 0,
    }
    let groupsBitKeys = getGroupBitKeys()
    for (let fName in data) {
        let fData  = data[fName];

        const {newItems, repeatingItems} = filterNewAndRepeatingItems(fData, index);
        const groupedNew = groupByKarma(newItems);
        const groupedRepeating = groupByKarma(repeatingItems);

        if(encType === 'rlp') {
            grouped[fName] = {
                [groupsBitKeys.rlpSingleNew.bin]: groupedNew.singles,
                [groupsBitKeys.rlpGroupNew.bin]: groupedNew.groups,
                [groupsBitKeys.rlpSingleRepeat.bin]: groupedRepeating.singles,
                [groupsBitKeys.rlpGroupRepeat.bin]: groupedRepeating.groups
            }
        } else if (encType === 'native') {
            grouped[fName] = groupDataNative(groupedNew, groupedRepeating)
        } else if (encType === 'bitmap') {
            grouped[fName] = groupDataBitmaps(groupedNew, groupedRepeating)
        } else {
            grouped[fName] = testGroupDataBitmapsClustered(groupedNew, groupedRepeating)
            totalSavings.savingsVsBitmap += grouped[fName].savingsVsBitmap;
            totalSavings.savingsVsNative += grouped[fName].savingsVsNative;

            totalSavings.hybridSavingVsBitmap += grouped[fName].hybridSavingVsBitmap;
            totalSavings.hybridSavingVsNative += grouped[fName].hybridSavingVsNative;
        }
        console.log(`grouped ${fName}`)

    }

    return {
        data: grouped,
        totalSavings: totalSavings,
        addrIndex: index
    }

}

const groupData = (argv) => {
    const dataset = argv.dataset;
    const encType = argv.encType;

    const jsonData = readData(dataset, 'json');

    console.log(`[${dataset}][${encType}] Grouping data...`);

    let groupedData = group(jsonData, encType);

    writeData(groupedData.data, dataset, 'grouped', encType);
    if(encType === 'bitmapCluster') {
        fs.writeFileSync(`data/grouped/bitmapCluster/${dataset}/total_savings.json`, JSON.stringify(groupedData.totalSavings))
    }


    if(!fs.existsSync(dataDirs.addrIndex)) {
        fs.mkdirSync(dataDirs.addrIndex)
    }

    fs.writeFileSync(`${dataDirs.addrIndex}/${dataset}_${encType}_index.json`, JSON.stringify(groupedData.addrIndex))

    console.log(`[${dataset}][${encType}] Data grouped!`);

};


module.exports = {
    groupData
}