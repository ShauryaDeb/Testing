// Load Express module
import express from 'express';
import crypto from 'crypto';
import { Pinecone } from '@pinecone-database/pinecone';
import mammoth from 'mammoth';
import fs from 'fs';
import unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import { encode, decode } from 'gpt-3-encoder';
import Stream from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';
const {Together} = await import("together-ai");
const { pipeline } = await import('@xenova/transformers');
const { JSDOM } = await import('jsdom');
import { createHash } from 'crypto';

const GPT_TOKEN_LIMIT = 5000; // Adjust this to your model (e.g., GPT-4o = 128000)
const AVG_CHARS_PER_TOKEN = 4; // Rough estimate


const pc = new Pinecone({
  apiKey: 'pcsk_2jwDNi_4BQq9WB9xJwzwBGKV5kVLCa9yWsZ2sWwx6XKMCiBcAFTZQSSVsTVNqcKWARPbXZ'
});

var apiKey = "773d4b4f1e5386c2764ec5c2c4ba65533c202d798a5d2da52804466a642167da"


const together = new Together({apiKey: apiKey}); // auth defaults to process.env.TOGETHER_API_KEY


const index = pc.index('debate-cards');



async function createIndex(name) {
  await pc.createIndex({
    name: name,
    dimension: 384,
    metric: 'cosine',  // or 'dotproduct', etc.
    spec: {
      serverless: {
        cloud: 'aws',
        region: 'us-east-1'
      },
    },
  });
}


var cardData = {
  "author": "Christopher Anders, Director Of Policy and Government Affairs, Democracy And Technology, American Civil Liberties Union",
  "month": "February",
  "year": 2025,
  "heading": "<b>What is an Executive Order and How Does it Work?</b>",
  "link": "https://www.aclupa.org/en/news/what-executive-order-and-how-does-it-work",
  "content": "But can President Trump actually carry out the policy plans outlined in his executive orders? Below, the ACLU explains the history, function, and limits of a presidential executive order. What Is an Executive Order? How Is It Different From a Law? Article II of the Constitution vests the president with executive power over the government, including the obligation to “take care that the laws be faithfully executed.” An executive order is a written directive, signed by the president, that orders the government to take specific actions to ensure “the laws be faithfully executed.” It might mean telling the Department of Education to implement a certain rule, or declaring a new policy priority. Executive orders, however, cannot override federal laws and statutes. Statutes have to be passed by Congress and signed by the president. Or, if vetoed, then Congress must override the veto for the bill to become law. Executive orders can’t preempt this process. Furthermore, the Constitution gives Congress control over things like taxation, spending, and certain war powers. Most things we think of when we think of laws come from Congress: what counts as a criminal offense, how much the federal government can tax our income, and declaring war or making treaties. With an executive order, the president can’t write a new statute, but an order can tell federal agencies how to implement a statute. For example, Congress can declare a certain drug legal or illegal. But with an executive order, the president can tell the Department of Justice if prosecuting certain drug cases is a priority or not. What Can and Can’t Trump Do Through Executive Order? With an executive order, President Trump can order the federal government to take any steps that are within the scope of the constitutional authority of the executive branch, and do not violate any federal law.",
  "type": ["explanation", "statutory limitation", "example"],
  "a2": "",
  "contention": ""
}

async function addCard(data) {

  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');


  const text = data.heading + data.content
  const embedding = await extractor(text, {
    pooling: 'mean',
    normalize: true
  });

  const flattenArray = (arr) => arr.reduce((flat, toFlatten) => flat.concat(Array.isArray(toFlatten) ? flattenArray(toFlatten) : toFlatten), []);

  const vectorValues = flattenArray(embedding.data);

  const idString = `${data.author}|${data.year}|${data.content}`;
  const id = crypto.createHash('sha256').update(idString).digest('hex');

  await index.upsert([{
    "id": id,
    values: vectorValues,
    metadata: data
  }])
}



async function addCards(data) {
  for (card of data) {
    addCard(card)
  }
}




async function getCards(keyword, metaData = {}, topK = 10) {

  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');


  const text = keyword
  const embedding = await extractor(text, {
    pooling: 'mean',
    normalize: true
  });

  const flattenArray = (arr) => arr.reduce((flat, toFlatten) => flat.concat(Array.isArray(toFlatten) ? flattenArray(toFlatten) : toFlatten), []);

  const vectorValues = flattenArray(embedding.data);

  const results = await index.query({
    topK: topK, 
    vector: vectorValues,
    includeMetadata: true,
    ...(Object.keys(metaData).length > 0 && { filter: metaData })
  })

  return results.matches
}


function extractCards(html) {
  const cardRegex = /\[Card Start\]\s*([\s\S]*?)\s*\[Card End\]/g;
  const cards = [];
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    cards.push(match[1].trim());
  }

  return cards;
}


function chunkCards(cards) {
  const chunks = [];
  let currentChunk = '';
  let currentTokenCount = 0;

  for (const card of cards) {
    const cardWithMarkers = `<p>[Card Start]</p>\n${card}\n<p>[Card End]</p>`;
    const cardTokens = encode(cardWithMarkers);
    const cardTokenCount = cardTokens.length;

    if (currentTokenCount + cardTokenCount > GPT_TOKEN_LIMIT) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
      currentTokenCount = 0;
    }

    currentChunk += cardWithMarkers + '\n\n';
    currentTokenCount += cardTokenCount;
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

async function getHTML(path) {


  // To get some formatting info (like bold), you can use `extractRawText` with custom options:
  var HTML = await mammoth.convertToHtml({ path: path})

  var html = HTML.value

  
  const directory = await unzipper.Open.file(path);
  const docFile = directory.files.find(file => file.path === "word/document.xml");

  const content = await docFile.buffer();
  const xml = content.toString();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    ignoreDeclaration: true,
  });

  const json = parser.parse(xml);
  const body = json["w:document"]["w:body"];

  const highlights = [];




  function extractRuns(paragraph) {
    function getAllRuns(paragraph) {
      let runs = [];

      // Runs directly inside paragraph
      if (paragraph["w:r"]) {
        if (Array.isArray(paragraph["w:r"])) {
          runs = runs.concat(paragraph["w:r"]);
        } else {
          runs.push(paragraph["w:r"]);
        }
      }

      // Runs inside hyperlinks
      if (paragraph["w:hyperlink"]) {
        const hyperlinks = Array.isArray(paragraph["w:hyperlink"]) ? paragraph["w:hyperlink"] : [paragraph["w:hyperlink"]];
        for (const hyperlink of hyperlinks) {
          if (hyperlink["w:r"]) {
            if (Array.isArray(hyperlink["w:r"])) {
              runs = runs.concat(hyperlink["w:r"]);
            } else {
              runs.push(hyperlink["w:r"]);
            }
          }
        }
      }

      return runs;
    }

    const runs = getAllRuns(paragraph)


    const dom = new JSDOM(html);
    const document = dom.window.document;

    var container = document.createElement("p");

    for (const run of runs) {
      if (!run || run == undefined) {; continue}

      function extractText(run, relsMap = {}) {

        // Check if run is a string or number itself (unlikely, but for safety)
        if (typeof run === "string" || typeof run === "number") return String(run);

        // Check if run contains text in "w:t"
        if (run["w:t"]) {
          const wt = run["w:t"];
          if (typeof wt === "string" || typeof wt === "number") return String(wt);
          if (wt && (typeof wt["#text"] === "string" || typeof wt["#text"] === "number")) {
            return String(wt["#text"]);
          }
        }

        // Check if run contains a hyperlink ("w:hyperlink") and get URL from relsMap
        if (run["w:hyperlink"]) {
          const hyperlink = run["w:hyperlink"];
          const linkId = hyperlink["@r:id"];
          if (linkId && relsMap[linkId]) {
            return relsMap[linkId]; // Return the URL only
          }
        }

        return "";
      }

      const text = extractText(run);



      if (text == undefined) {
        console.log(run["w:t"])
        continue
      }

      if (String(text).trim() == "") continue; // Skip empty text nodes

      const rPr = run["w:rPr"];
    
      // Space is for readabili
      let node = document.createTextNode(text + " ");
      

      if (rPr && "w:highlight" in rPr) {
        const highlightVal = rPr["w:highlight"]["w:val"];
        if (highlightVal && highlightVal.toLowerCase() !== "white") {
          const span = document.createElement("span");
          span.className = "highlight";
          span.appendChild(node);
          node = span;
        }
      }


      if (rPr && rPr["w:b"] != undefined) {
        const boldWrapper = document.createElement("strong");
        boldWrapper.appendChild(node);
        node = boldWrapper;
      }


      container.appendChild(node);
    }

    

    

    return container;
  } 


  
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const outputContainer = document.createElement("div");

  const paragraphs = Array.isArray(body["w:p"]) ? body["w:p"] : [body["w:p"]];
  for (const paragraph of paragraphs) {
    const pNode =  extractRuns(paragraph);
    outputContainer.appendChild(pNode);
  }


  let cards = [];
  let currentCard = null;




    
  function cleanHtml(html) {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const allowedTags = ['b', 'span'];

    const allElements = [...document.body.querySelectorAll('*')];

    for (const el of allElements) {
      const tag = el.tagName.toLowerCase();

      // Allow <b>
      if (tag === 'strong') continue;

      // Allow <span class="highlight"> only
      if (tag === 'span' && el.classList.contains('highlight')) continue;

      // Unwrap all other elements
      while (el.firstChild) {
        el.parentNode.insertBefore(el.firstChild, el);
      }
      el.remove();
    }

    return document.body.innerHTML;
  }

    
  function hasURL(text) {
    const urlRegex = /(https?:\/\/\S+|\S+\.(com|org|edu|net|gov|info|co|io|us|ca|uk)(\/\S*)?)/i;
    return urlRegex.test(text);
  }

function addCardMarkers(html) {
  const $ = cheerio.load(html);
  const paragraphs = $('p').toArray();
  const newContent = [];
  let buffer = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const $p = $(paragraphs[i]);
    const isBoldStart = $p.find('strong, b').first().closest('p')[0] === $p[0];

    if (isBoldStart && buffer.length > 0) {
      // Close previous card
      newContent.push('<p>[Card Start]</p>');
      buffer.forEach(p => newContent.push($.html(p)));
      newContent.push('<p>[Card End]</p>');
      // Start new card with current paragraph
      buffer = [paragraphs[i]];
    } else {
      buffer.push(paragraphs[i]);
    }
  }

  // Flush remaining buffer at the end
  if (buffer.length > 0) {
    newContent.push('<p>[Card Start]</p>');
    buffer.forEach(p => newContent.push($.html(p)));
    newContent.push('<p>[Card End]</p>');
  }

  return newContent.join('\n');
}



  var finalHtml = cleanHtml(addCardMarkers((outputContainer.innerHTML)));

  return finalHtml
  
}


async function uploadDocumentToDatabase(path) {
  console.log("Starting to upload document to database...")
  console.log("Loading HTML...")


  var html = await getHTML(path)

  console.log("HTML loaded")

  var index = 1

  var extractedCards = extractCards(html);

  var chunkedCards = chunkCards(extractedCards);



  for (let i = 0; i < chunkedCards.length; i++) {
    console.log("Analyzing data...", i)
    const response = await together.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a public forum debate card analyzer. From the partial html code given, return requested data as JSON only\n\nOnly return the JSON result. Do not explain anything. Do not include thoughts, reasoning, or markdown. Just return a valid JSON string. This text you return will go directly into a JSON database. \n\nOne full card consists of an: Author, date, content, and type. The rest are optional. If a card is not complete, please check for the next card segment for the remaining details. \nIt is possible that multiple card segments [Card Start] and [Card End] are actually part of a single card. It is also possible that between a  [Card Start] and [Card End] are multiple cards, that can be differentiated by Author, date, content, and type. If in total there are multiple cards across the entire html code, please put all json objects into a list. \n\nFor the author, it is the author of the person who wrote the article. Please surround the last name of the author with <strong> html tags\n\nThe month if found is the month the article was written, not accessed. Please do the name of the month not the number.\n\nThe year is the year the article was written, not accessed, or any other year found in the content. Please include the full year including the “20” or “19” at the start. Please surround this number by a <span class=’highlight’>, but if no text in the content contains a highlight, then please use a <strong> tag. \n\nHeading: This is usually the text before the citing if found. If not found, it is the article name. If neither, put it as what you seem best fitting. \n\nLink: This is the url of the article. If it is not in proper format, please fix. \n\nContent: This is the text after the citing. Please only include the text surrounded by the <strong> and <span class=’’highlight’> html tags and the tags itself. Even if it may seem messy just do it. \nFor the class=”highlight”, please use the ‘ marks instead of “, since it will break the string otherwise. \n\nType: Please choose from the list: [Non unique (Means the impact happens in both worlds, primarly used in blocks), link (Shopws how something happens), delink (Shows how something does not happen), impact (Shows what happens as a result), mitigation (Shows how a negative is not as bad), statistic, historical example. Only from these options please. It can be multiple types if you believe it can be multiple. The format is a list []\n\nA2: This is similar to a heading, only set this property if anywhere it states “A2” or “AT”, unless the text after a2 or at is “aff” or “neg”. It is also possible it will not say A2 or AT, and this will usually be above the cards. If an \"A2\" is found, all cards under it should have their property of A2 be set to this. Isolated text may also be this, as it is a label or catagory for the cards. \n\nContention: Similar to A2, if teh text states contention, please set this property as the text after “contention”\n\nIf any property was not set/found, set it as an empty string like such \"\"\n\n\n{ \nauthor \nmonth\nyear\nheading \nlink\ncontent type \na2 \ncontention \n}\n"
        },
        {
          "role": "user",
          "content": `<p>${chunkedCards[i]}</p>`
        }
      ],
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
    });

    console.log("Response received, starting to add to database")


    const added = await addCards(JSON.parse(response.choices[0].message.content))

    console.log("Cards added to database: Chunk", i)
  }

  console.log("All cards added to database. Starting server...");
}



// (async function startup() {
//   uploadDocumentToDatabase("C:/Users/shaur/Downloads/docx_files/Mount Si PS Blockfile AI March.docx")

// })();

// (async () => {
//   var html = await getHTML()


//   var index = req.query.index;

//   var extractedCards = extractCards(html);

//   var chunkedCards = chunkCards(extractedCards);


//   res.send(chunkedCards[index]+ "<style>.highlight {background-color: rgb(0,255,0);}</style>")
// })();



console.log("Starting server...")

const app = express();
const port = 3000;

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);

// Get the directory name of the current file
const __dirname = path.dirname(__filename);




app.get("/api/message", (req, res) => {
  const prompt = req.query.prompt
  const chatId = req.query.chatId

  if (prompt == undefined || prompt == null || prompt.trim() == "") {return res.status(400).json({ error: "Prompt is required" }); }
  if (chatId == undefined || chatId == null || chatId.trim() == "") {return res.status(400).json({ error: "chatId is required" }); }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  (async () => {
    const response = await together.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "\nYou are a public forum debate bot. Your task is to read the following text and return a JSON, and ONLY a JSON, in the format:\n\n{\n  \"speechType\": \"\" (Constructive, Rebuttal, Summary, FinalFocus — default to \"Constructive\" if not given, \"Rebuttal\" if the text says something like \"here is my opponent's flow\"),\n  \"cards\": [] (list of topics to find evidence for — if the text is a rebuttal, flip the sentiment on each topic, e.g. \"executive orders good\" → \"executive orders bad\"),\n  \"wordCount\": number (default to 500 if not specified)\n}"
        },
        {
          "role": "user",
          "content": prompt
        }
      ],
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
      stream: false
    });


    const data = JSON.parse(response.choices[0].message.content)

    console.log("Response received:", data);
    console.log(await getCards(data.cards[0], {}, 1))

    // const stream = await together.chat.completions.create({
    //   messages: [
    //     {
    //       role: "system",
    //       content: prompt + "add <span class='highlight'> html tags around important words and phrases",
    //     }
    //   ],
    //   model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
    //   stream: true, // Set to true if you want streaming responses
    // });

    // for await (const chunk of stream) {
    //   res.write(`data: ${JSON.stringify(chunk.choices[0].delta.content)}\n\n`);
    // }



    const testSentence = "Hi this is a <span class='highlight'>test</span> response";
    const words = testSentence.split(" ");


    for (const word of words) {
      setTimeout(function(){res.write(`data: ${JSON.stringify(word + " ")}\n\n`);},1000)
      await new Promise((r) => setTimeout(r, 300)); // simulate streaming delay
    }

    res.write("event: done\ndata: {}\n\n");
    res.end();
  })();
});



// Serve the single-page front-end.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();


  // Get the current file path
  const __filename = fileURLToPath(import.meta.url);

  // Get the directory name of the current file
  const __dirname = path.dirname(__filename);
  res.sendFile(path.join(__dirname, "client", "index.html"));
});



// Start the server and listen on the specified port
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});


