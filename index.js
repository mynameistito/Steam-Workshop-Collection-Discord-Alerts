const axios = require('axios');
const fs = require('fs');
const path = require('path');
const URLSearchParams = require('url').URLSearchParams;
const cheerio = require('cheerio');

const API_KEY = 'YOUR-STEAMAPI-KEY';
const COLLECTION_ID = 'YOUR-STEAM-COLLECTION-ID';
const INTERVAL = 1 * 60 * 1000; // Check every 1 min
const SCRAPE_INTERVAL = 7000; // 7 seconds delay between scrape requests
const UPDATE_SCRAPE_INTERVAL = 2 * 60 * 60 * 1000; // 6 hours in milliseconds
const webhookUrl = 'https://discord.com/api/webhooks/YOUR-CHANNEL-WEBHOOK';

let isScrapingInProgress = false;

const fetchData = async () => {
    try {
        const params = new URLSearchParams();
        params.append('key', API_KEY);
        params.append('collectioncount', '1');
        params.append('publishedfileids[0]', COLLECTION_ID);

        const response = await axios.post(
            'https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/', 
            params,
            {
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded' 
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error fetching data:', error);
        return null;
    }
};

const updateAllMaps = async () => {
    const filePath = path.join(__dirname, 'collection_data.json');
    const scrapedDataPath = path.join(__dirname, 'workshop_items_details.json');
    if (!fs.existsSync(filePath) || !fs.existsSync(scrapedDataPath)) {
        console.log('Initial data not available for update check.');
        return;
    }

    const collectionData = JSON.parse(fs.readFileSync(filePath, 'utf8')).response;
    const existingScrapedData = JSON.parse(fs.readFileSync(scrapedDataPath, 'utf8'));
    const workshopItems = collectionData.collectiondetails[0].children.map(child => child.publishedfileid);

    console.log(`Updating all ${workshopItems.length} workshop items...`);
    const scrapedData = await scrapeWorkshopItems(workshopItems);

    saveData(collectionData, scrapedData, existingScrapedData, []);
};

setInterval(updateAllMaps, UPDATE_SCRAPE_INTERVAL);

const fetchWorkshopItemDetails = async (id) => {
    try {
        console.log(`Fetching details for item ${id}`);
        const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
        const response = await axios.get(url, { timeout: 10000 });
        const $ = cheerio.load(response.data);

        const title = $('.workshopItemTitle').text().trim();
        const imageUrl = $('meta[property="og:image"]').attr('content');

        const fileSize = $('.detailsStatsContainerRight .detailsStatRight').first().text().trim();
        const postedDate = $('.detailsStatsContainerRight .detailsStatRight').eq(1).text().trim();
        const updatedDate = $('.detailsStatsContainerRight .detailsStatRight').eq(2).text().trim();

        // Find the changelog link
        let changelogUrl = null;
        // Look for the "Change Notes" tab or link typically found in Steam Workshop pages
        const changeNotesLink = $('.tabsLinks a').filter(function() {
            return $(this).text().trim().includes('Change Notes');
        }).attr('href');
        
        if (changeNotesLink) {
            changelogUrl = changeNotesLink;
        } else {
            // If no dedicated tab, the changelog may be in the URL with a section parameter
            changelogUrl = `${url}&section=changelog`;
        }

        return {
            id,
            title,
            fileSize,
            postedDate,
            updatedDate,
            imageUrl,
            changelogUrl,
            lastChecked: new Date().toISOString()
        };
    } catch (error) {
        console.error(`Error fetching details for item ${id}:`, error.message);
        return { 
            id, 
            title: 'Error fetching data', 
            fileSize: null, 
            postedDate: null, 
            updatedDate: null, 
            imageUrl: null,
            changelogUrl: null,
            lastChecked: new Date().toISOString()
        };
    }
};

const scrapeWorkshopItems = async (items) => {
    if (isScrapingInProgress) {
        console.log('Scraping already in progress. Skipping new scrape request.');
        return [];
    }

    isScrapingInProgress = true;
    const results = [];
    console.log(`Starting to scrape ${items.length} workshop items`);

    for (const id of items) {
        const result = await fetchWorkshopItemDetails(id);
        results.push(result);
        await new Promise(resolve => setTimeout(resolve, SCRAPE_INTERVAL));
    }

    console.log('Completed scraping workshop items');
    isScrapingInProgress = false;
    return results;
};

const checkForUpdates = async () => {
    const newData = await fetchData();
    if (!newData) return;

    const filePath = path.join(__dirname, 'collection_data.json');
    const workshopItems = newData.response.collectiondetails[0].children.map(child => child.publishedfileid);

    const scrapedDataPath = path.join(__dirname, 'workshop_items_details.json');
    let existingScrapedData = {};
    if (fs.existsSync(scrapedDataPath)) {
        existingScrapedData = JSON.parse(fs.readFileSync(scrapedDataPath, 'utf8'));
    }

    // Items that don't exist in our scraped data yet
    const itemsToUpdate = workshopItems.filter(id => !existingScrapedData[id]);
    
    // Items that exist in our scraped data but not in the collection anymore
    const removedItemIds = Object.keys(existingScrapedData).filter(id => !workshopItems.includes(id));
    
    // First, let's get the latest data for new items and potential updates
    let scrapedData = [];
    let updatedItemIds = [];
    
    if (itemsToUpdate.length > 0) {
        // Scrape new items
        scrapedData = await scrapeWorkshopItems(itemsToUpdate);
    }
    
    if (fs.existsSync(filePath)) {
        const oldData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // Check if the collection data has actually changed
        const collectionChanged = JSON.stringify(oldData.response) !== JSON.stringify(newData.response);
        
        if (collectionChanged || itemsToUpdate.length > 0 || removedItemIds.length > 0) {
            // If collection structure changed, we need to check for updated items
            if (collectionChanged) {
                console.log("Collection structure changed, checking for updated items...");
                // We only need to check existing items that weren't just added
                const itemsToCheck = workshopItems.filter(id => existingScrapedData[id] && !itemsToUpdate.includes(id));
                
                if (itemsToCheck.length > 0) {
                    const potentialUpdates = await scrapeWorkshopItems(itemsToCheck);
                    
                    // Compare with existing data to find actual updates
                    updatedItemIds = potentialUpdates
                        .filter(item => {
                            const existingItem = existingScrapedData[item.id];
                            return (
                                existingItem && (
                                    item.fileSize !== existingItem.fileSize ||
                                    item.updatedDate !== existingItem.updatedDate
                                )
                            );
                        })
                        .map(item => item.id);
                    
                    // Add updated items to our scraped data
                    if (updatedItemIds.length > 0) {
                        scrapedData = [...scrapedData, ...potentialUpdates.filter(item => updatedItemIds.includes(item.id))];
                    }
                }
            }
            
            console.log(`Collection has been updated. ${itemsToUpdate.length} maps added, ${removedItemIds.length} maps removed, ${updatedItemIds.length} maps updated.`);
            
            if (scrapedData.length > 0 || removedItemIds.length > 0) {
                await sendDiscordNotification(scrapedData, removedItemIds, updatedItemIds, existingScrapedData);
                saveData(newData.response, scrapedData, existingScrapedData, removedItemIds);
                
                // Log changes
                logChanges(
                    scrapedData.filter(item => itemsToUpdate.includes(item.id)), 
                    removedItemIds, 
                    existingScrapedData
                );
            }
        } else {
            console.log('No changes detected');
        }
    } else {
        console.log(`Initial data save. Starting to scrape ${workshopItems.length} workshop items`);
        const allItemsData = await scrapeWorkshopItems(workshopItems);
        saveData(newData.response, allItemsData, {}, []);
    }
};

const logChanges = (addedItems, removedItems, existingScrapedData) => {
    const logFilePath = path.join(__dirname, 'update_log.txt');
    const timestamp = new Date().toISOString();

    let logMessage = `[${timestamp}] Update Detected:\n`;

    if (addedItems.length > 0) {
        logMessage += `Added Maps (${addedItems.length}): \n`;
        addedItems.forEach(item => logMessage += ` - ${item.id}: ${item.title}\n`);
    }

    if (removedItems.length > 0) {
        logMessage += `Removed Maps (${removedItems.length}): \n`;
        removedItems.forEach(id => logMessage += ` - ${id}: ${existingScrapedData[id]?.title || 'Unknown Title'}\n`);
    }

    fs.appendFileSync(logFilePath, logMessage);
};

const sendDiscordNotification = async (scrapedData, removedItemIds, updatedItemIds, existingScrapedData) => {

    let allEmbeds = [];

    // Add new maps
    allEmbeds.push(...scrapedData
        .filter(item => !existingScrapedData[item.id])
        .map(item => {
            return {
                title: `Added Map: ${item.title}`,
                url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`,
                image: { url: item.imageUrl },
                fields: [
                    { name: 'File Size', value: item.fileSize || 'Unknown', inline: true },
                    { name: 'Posted Date', value: item.postedDate || 'Unknown', inline: true },
                    { name: 'Updated Date', value: item.updatedDate || 'Unknown', inline: true }
                ],
                color: 3066993
            };
        })
    );

    // Add updated maps
    allEmbeds.push(...scrapedData
        .filter(item => updatedItemIds.includes(item.id))
        .map(item => {
            const fields = [
                { name: 'File Size', value: item.fileSize || 'Unknown', inline: true },
                { name: 'Posted Date', value: item.postedDate || 'Unknown', inline: true },
                { name: 'Updated Date', value: item.updatedDate || 'Unknown', inline: true }
            ];

            // Add changelog field if available
            if (item.changelogUrl) {
                fields.push({ 
                    name: 'Changelog', 
                    value: `[View Change Notes](${item.changelogUrl})`,
                    inline: false 
                });
            }

            return {
                title: `Updated Map: ${item.title}`,
                url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`,
                image: { url: item.imageUrl },
                fields: fields,
                color: 15844367
            };
        })
    );

    // Add removed maps
    allEmbeds.push(...removedItemIds.map(id => {
        const item = existingScrapedData[id];
        return {
            title: `Removed Map: ${item?.title || 'Unknown Map'}`,
            color: 15158332
        };
    }));

    // Send notifications
    for (const embed of allEmbeds) {
        await sendSingleEmbed(embed);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
};

const sendSingleEmbed = async (embed) => {
    try {
        await axios.post(webhookUrl, { embeds: [embed] });
        console.log(`Discord notification sent for ${embed.title}`);
    } catch (error) {
        console.error(`Failed to send Discord notification for ${embed.title}:`, error.message);
    }
};

const saveData = (response, scrapedData, existingScrapedData, removedItems) => {
    const responsePath = path.join(__dirname, 'collection_data.json');
    const scrapedDataPath = path.join(__dirname, 'workshop_items_details.json');

    fs.writeFileSync(responsePath, JSON.stringify({ response, lastUpdated: new Date().toISOString() }, null, 2), 'utf8');

    const updatedScrapedData = { ...existingScrapedData };

    scrapedData.forEach(newItem => {
        updatedScrapedData[newItem.id] = newItem;
    });

    removedItems.forEach(id => {
        delete updatedScrapedData[id];
    });

    try {
        console.log('Preparing to write scraped data...');
        const jsonData = JSON.stringify(updatedScrapedData, null, 2);
        console.log('JSON data prepared, writing to file...');
        fs.writeFileSync(scrapedDataPath, jsonData, 'utf8');
        console.log('Data written successfully');
    } catch (error) {
        console.error('Error in saveData function:', error.message);
    }
};

setInterval(checkForUpdates, INTERVAL);
checkForUpdates();
