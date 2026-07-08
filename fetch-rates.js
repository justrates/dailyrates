const fs = require('fs');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const rates = {};

async function saveRate(provider, buyRate, sellRate) {
  if (!buyRate || !sellRate) return;
  rates[provider] = {
    buy_rate: buyRate,
    sell_rate: sellRate,
    updated_at: new Date().toISOString()
  };
  console.log(`Saved rate for ${provider}: Buy ₦${buyRate}, Sell ₦${sellRate}`);
}

async function fetchCadremit() {
  try {
    let buy = 1010; 
    let sell = 1020; 

    try {
      const response = await axios.get('https://rates.icekidex.workers.dev/', {
        headers: {
          'accept': 'application/json',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        }
      });
      const data = response.data;
      const ngnRates = data?.data?.rates?.CAD?.NGN;
      if (ngnRates) {
        buy = parseFloat(ngnRates.buy);
        sell = parseFloat(ngnRates.sell);
      }
    } catch (e) {
      console.error(`Cadremit API fetch failed: ${e.message}`);
    }

    await saveRate('cadremit', buy, sell);
  } catch (error) {
    console.error(`Cadremit fetch failed: ${error.message}`);
  }
}

async function fetchLemfi() {
  try {
    let buy = null;
    let sell = null;

    const decodeRate = (rawRate, id) => {
      const digits = id.replace(/\D/g, '');
      return parseFloat(rawRate) / parseFloat(digits);
    };

    try {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-app-locale': 'en-ca', 'user-agent': 'Mozilla/5.0' };
      
      const cadToNgnResponse = await axios.post('https://lemfi.com/api/lemonade/v2/exchange', 
        { from: 'CAD', to: 'NGN', sender_country: 'Canada' },
        { headers }
      ).catch(() => null);

      const ngnToCadResponse = await axios.post('https://lemfi.com/api/lemonade/v2/exchange', 
        { from: 'NGN', to: 'CAD', sender_country: 'Nigeria' },
        { headers }
      ).catch(() => null);

      const cadToNgn = cadToNgnResponse?.data;
      const ngnToCad = ngnToCadResponse?.data;

      if (cadToNgn?.data?.rate && cadToNgn?.data?.ID) {
        buy = Math.round(decodeRate(cadToNgn.data.rate, cadToNgn.data.ID) * 100) / 100;
      }

      if (ngnToCad?.data?.rate && ngnToCad?.data?.ID) {
        const ngnRate = decodeRate(ngnToCad.data.rate, ngnToCad.data.ID);
        sell = Math.round((1 / ngnRate) * 100) / 100;
      }

      if (buy && !sell) {
        sell = buy + 82;
        console.warn('Lemfi: NGN->CAD rate unavailable, using estimated sell rate');
      }
    } catch (e) {
      console.error(`Lemfi API fetch failed: ${e.message}`);
    }

    if (buy !== null) {
      await saveRate('lemfi', sell || buy, buy);
    }
  } catch (error) {
    console.error(`Lemfi fetch failed: ${error.message}`);
  }
}

async function fetchAfrichange() {
  try {
    let browserArgs = { headless: true, args: ['--no-sandbox'] };
    const browser = await puppeteer.launch(browserArgs);
    const page = await browser.newPage();
    
    let buy = 1035;
    let sell = 1045;
    let resolved = false;

    page.on('response', async (response) => {
      if (response.url().includes('Rate/active')) {
        try {
          const data = await response.json();
          const rates = data?.data || [];
          const buyRate = rates.find((r) => r.sendingCurrencyCode === 'CAD' && r.receivingCurrencyCode === 'NGN');
          const sellRate = rates.find((r) => r.sendingCurrencyCode === 'NGN' && r.receivingCurrencyCode === 'CAD');
          
          if (buyRate && buyRate.exchangeRate) {
            buy = parseFloat(buyRate.exchangeRate);
            sell = (sellRate && sellRate.exchangeRate) ? (1 / parseFloat(sellRate.exchangeRate)) : buy;
            resolved = true;
          }
        } catch (e) {}
      }
    });

    await page.goto('https://africhange.com', { waitUntil: 'networkidle2', timeout: 60000 });
    for (let i = 0; i < 40; i++) {
      if (resolved) break;
      await new Promise(r => setTimeout(r, 500));
    }
    await browser.close();

    await saveRate('africhange', sell || buy, buy);
  } catch (error) {
    console.error(`Africhange fetch failed: ${error.message}`);
  }
}

async function fetchYolat() {
  try {
    const response = await axios.get('https://api.yolat.com/api/Rate', {
      headers: {
        'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }
    });
    
    const ratesResponse = response.data?.data || [];
    const buyData = ratesResponse.find((r) => r.sendCode === 'CAD' && r.receiveCode === 'NGN');
    const sellData = ratesResponse.find((r) => r.sendCode === 'NGN' && r.receiveCode === 'CAD');
    
    if (buyData?.amount) {
      const buy = parseFloat(buyData.amount);
      const sell = sellData?.amount ? (1 / parseFloat(sellData.amount)) : null;

      await saveRate('yolat', sell || buy, buy);
    }
  } catch (error) {
    console.error(`Yolat fetch failed: ${error.message}`);
  }
}

async function fetchPesa() {
  try {
    const response = await axios.get('https://backend-api.prod.pesapeer.com/v2/public/currency-pairs', {
      headers: {
        'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }
    });
    
    const ratesResponse = response.data || [];
    const buyRateObj = ratesResponse.find((r) => r.from_currency_code === 'CAD' && r.to_currency_code === 'NGN');
    const sellRateObj = ratesResponse.find((r) => r.from_currency_code === 'NGN' && r.to_currency_code === 'CAD');
    
    if (buyRateObj?.pesapeer_rate) {
      const buy = parseFloat(buyRateObj.pesapeer_rate);
      let sell = null;
      if (sellRateObj?.pesapeer_rate) {
         sell = 1 / parseFloat(sellRateObj.pesapeer_rate);
      } else {
         sell = buy + 54; // fallback
      }

      await saveRate('pesa', sell || buy, buy);
    }
  } catch (error) {
    console.error(`Pesa fetch failed: ${error.message}`);
  }
}

async function fetchCompa() {
  try {
    console.log('Fetching Compa...');
    
    // Buy CAD (Give NGN, get CAD)
    const buyResponse = await axios.get('https://www.compa.exchange/api/rates?direction=NGN-CAD&amount=1');
    // Sell CAD (Give CAD, get NGN)
    const sellResponse = await axios.get('https://www.compa.exchange/api/rates?direction=CAD-NGN&amount=1');
    
    const buyRatesList = buyResponse.data?.rates || [];
    const sellRatesList = sellResponse.data?.rates || [];
    
    const buyRates = {};
    for (const r of buyRatesList) {
      if (r.provider && r.rate) buyRates[r.provider.toLowerCase().replace(/\s+/g, '_')] = parseFloat(r.rate);
    }
    
    const sellRates = {};
    for (const r of sellRatesList) {
      if (r.provider && r.rate) sellRates[r.provider.toLowerCase().replace(/\s+/g, '_')] = parseFloat(r.rate);
    }

    const allProviders = new Set([...Object.keys(buyRates), ...Object.keys(sellRates)]);
    
    // Blocklist for currency calculators or non-remittance providers that show unrealistic mid-market rates
    const blocklist = ['xe', 'transfergo', 'google', 'oanda', 'bloomberg'];
    
    for (const provider of allProviders) {
      // Don't save recursive compa rates or blocklisted providers
      if (provider.includes('compa') || blocklist.includes(provider.toLowerCase())) continue;
      
      let buy = buyRates[provider] || null;
      let sell = sellRates[provider] || null;
      
      // If rate is in CAD per NGN, take reciprocal to get NGN per CAD
      if (buy && buy < 1) buy = 1 / buy;
      if (sell && sell < 1) sell = 1 / sell;
      
      if (buy || sell) {
        const finalBuy = buy || (sell + 50);
        const finalSell = sell || (buy - 50);
        await saveRate(`compa_${provider}`, finalBuy, finalSell);
      }
    }
    
    console.log(`Successfully fetched ${allProviders.size} providers from Compa API.`);
  } catch (error) {
    console.error(`Compa API fetch failed: ${error.message}`);
  }
}

async function runAll() {
  console.log('Starting rates fetcher...');
  await Promise.allSettled([
    fetchCadremit(),
    fetchLemfi(),
    fetchAfrichange(),
    fetchYolat(),
    fetchPesa(),
    fetchCompa()
  ]);

  const outputPath = path.join(__dirname, 'rates.json');
  fs.writeFileSync(outputPath, JSON.stringify(rates, null, 2));
  console.log(`Saved rates to ${outputPath}`);
}

runAll().catch(console.error);
