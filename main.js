const Apify = require('apify');
const { puppeteer } = Apify.utils;
const _ = require('underscore');
const safeEval = require('safe-eval');

let detailsEnqueued = 0;

Apify.events.on('migrating', async () => {
    await Apify.setValue('detailsEnqueued', detailsEnqueued);
});

Apify.main(async () => {
    const input = await Apify.getInput();
    console.log('Input:');
    console.dir(input);

    if (!input || !Array.isArray(input.startUrls) || input.startUrls.length === 0) {
        throw new Error("Invalid input, it needs to contain at least one url in 'startUrls'.");
    }

    let extendOutputFunction;
    if (typeof input.extendOutputFunction === 'string' && input.extendOutputFunction.trim() !== '') {
        try {
            extendOutputFunction = safeEval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(`'extendOutputFunction' is not valid Javascript! Error: ${e}`);
        }
        if (typeof extendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default ouput!');
        }
    }

    const requestQueue = await Apify.openRequestQueue();

    detailsEnqueued = await Apify.getValue('detailsEnqueued');
    if (!detailsEnqueued) {
        detailsEnqueued = 0;
    }

    function checkLimit() {
        return input.maxItems && detailsEnqueued >= input.maxItems;
    }

    for (const item of input.startUrls) {
        const startUrl = item.url;

        if (checkLimit()) {
            break;
        }

        if (startUrl.includes('https://www.forever21.com/')) {
            if (startUrl.includes('/product/')) {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'item' } });
                detailsEnqueued++;
            } else {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'list' } });
            }
        }
    }

    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,

        handlePageFunction: async ({ request, page }) => {
            if (request.userData.label === 'list') {
                let result = await page.evaluate(() => {
                    const data = [];
                    const links = $('a.item_slider.product_link');

                    for (let index = 0; index < links.length; index++) {
                        data.push(links[index].href);
                    }

                    return data;
                });

                for (const link of result) {
                    if (checkLimit()) {
                        break;
                    }

                    await requestQueue.addRequest({ url: link, userData: { label: 'item' } });
                    detailsEnqueued++;
                }

                while (true) {
                    const endPage = await page.evaluate(async () => {
                        const nextEle = $('#bottom-pager .p_next.inactive');

                        if (nextEle.length === 0) {
                            $('#bottom-pager .p_next').click();
                        }

                        return nextEle.length === 1;
                    });
                    
                    if (endPage) {
                        break;
                    }

                    try {
                        await page.waitFor(500); // to wait for 500ms
                        await page.waitFor(() => $('.loading').is(":hidden"), { timeout: 10000 });
                    } catch (error) {}

                    let result = await page.evaluate(() => {
                        const data = [];
                        const links = $('a.item_slider.product_link');
    
                        for (let index = 0; index < links.length; index++) {
                            data.push(links[index].href);
                        }
    
                        return data;
                    });

                    for (const link of result) {
                        if (checkLimit()) {
                            break;
                        }

                        await requestQueue.addRequest({ url: link, userData: { label: 'item' } });
                        detailsEnqueued++;
                    }
                }
            } else if (request.userData.label === 'item') {
                const title = await page.title();
                console.log(`Title of ${request.url}: ${title}`);
                const parts = request.url.split('/');
                const itemId = parts[parts.length - 1];

                const result = await page.evaluate(() => {
                    const data = {};

                    data['brand'] = brand;
                    data['price'] = $('#ItemPrice span').text();
                    data['description'] = $('#tabDescriptionContent').text();
                    data['color'] = $('#selectedColorName').text();
                    data['sizes'] = $('#sizeButton li span').map(function() { return $( this ).text(); }).toArray();

                    return data;
                });

                await Apify.pushData({
                    title,
                    itemId,
                    ...result,
                    '#debug': Apify.utils.createRequestDebugInfo(request),
                });
            }
        },

        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed too many times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },

        maxRequestRetries: 2,
        maxRequestsPerCrawl: 1000,
        maxConcurrency: 5,

        launchPuppeteerOptions: {
            ...input.proxyConfiguration,
        },
    });

    await crawler.run();
});
