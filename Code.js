function doGet() {
  try {
    const expirationDate = new Date("2025-04-29T23:30:00Z");
    const now = new Date();

    console.log("Form accessed at: " + now);
    console.log("Active spreadsheet: " + SpreadsheetApp.getActiveSpreadsheet().getName());

    if (now > expirationDate) {
      return HtmlService.createHtmlOutput("<h2>This link has expired.</h2>");
    }

    // Create HTML output without restricted meta tags
    const html = HtmlService.createHtmlOutputFromFile('form')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .setTitle('FDB Bank Quiz'); // Set title instead of meta tags

    return html;

  } catch (e) {
    console.error("Error in doGet: " + e.message);
    return HtmlService.createHtmlOutput("<h2>An error occurred while loading the form. Please try again later.</h2>");
  }
}

function getRandomQuestions() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Question Database");
    if (!sheet) {
      console.error("Question Database sheet not found");
      return [];
    }
    
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return []; // No questions
    
    // Skip header and filter valid questions (at least question + 3 options)
    const validQuestions = data.slice(1).filter(row => 
      row[1] && row[2] && row[3] && row[4]&& row[5]&& row[6] // Require question + 3 options
    );
    
    // Shuffle and select max 3 questions
    const shuffled = validQuestions.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 10);
    
    // Format for frontend - include all non-empty options
    return selected.map(row => {
      const options = [row[2], row[3], row[4], row[5], row[6]]
        .filter(opt => opt && opt.toString().trim() !== "")
        .map(opt => opt.toString().trim());
      
      return {
        question: row[1].toString().trim(),
        options: options.length > 0 ? options : ["No options provided"]
      };
    });
    
  } catch (e) {
    console.error("Error in getRandomQuestions: " + e.message);
    return [];
  }
}



function submitAnswers(data) {
  const lock = LockService.getScriptLock();
  try {
    // Acquire lock with timeout
    lock.waitLock(10000); // Increased to 10 seconds for safety
    
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const responseSheet = ss.getSheetByName("Result");
    const datasetSheet = ss.getSheetByName("Question Database");

    // Initialize headers if empty
    if (responseSheet.getLastRow() === 0) {
      setupHeaders();
    }

    // Validate and normalize email
    const email = (data.email || "").toString().trim().toLowerCase();
    if (!email) {
      return { status: "error", message: "Email is required." };
    }
    
    // Enhanced email validation
    if (!/^[a-z0-9._%+-]+@fdbbank\.com$/i.test(email)) {
      return { status: "error", message: "Only @fdbbank.com emails are allowed." };
    }

    // Debug logging
    console.log(`Processing submission for: ${email}`);
    console.log(`Current time: ${new Date()}`);

    // Improved duplicate check
    const emailColumnIndex = 2; // Column B for emails
    const lastRow = responseSheet.getLastRow();
    
    if (lastRow > 1) {
      const emailRange = responseSheet.getRange(2, emailColumnIndex, lastRow-1, 1);
      const existingEmails = emailRange.getValues()
        .flat()
        .map(e => (e || "").toString().trim().toLowerCase());
      
      console.log(`Existing emails: ${existingEmails.join(', ')}`);
      
      if (existingEmails.includes(email)) {
        const duplicateIndex = existingEmails.indexOf(email) + 2; // +2 for header and 1-based index
        const duplicateTime = responseSheet.getRange(duplicateIndex, 1).getValue();
        console.log(`Duplicate found at row ${duplicateIndex}, submitted at ${duplicateTime}`);
        
        return { 
          status: "duplicate", 
          message: `You already submitted the quiz on ${duplicateTime.toLocaleString()}.` 
        };
      }
    }

    // Process answers
    const answers = data.answers;
    const dataset = datasetSheet.getDataRange().getValues();
    
    if (dataset.length <= 1) {
      return { status: "error", message: "No questions found in the database." };
    }

    // Create answer map
    const answerMap = {};
    for (let i = 1; i < dataset.length; i++) {
      const question = dataset[i][1]?.toString().normalize('NFC').replace(/\s+/g, ' ').trim();
      const correctAnswer = dataset[i][7]?.toString().normalize('NFC').replace(/\s+/g, ' ').trim() || '';
      if (question && correctAnswer) {
        answerMap[question] = correctAnswer;
      }
    }

    // Calculate score and prepare response row
    let score = 0;
    const responseRow = [new Date(), email];
    const unansweredQuestions = [];

    answers.forEach((item, index) => {
      const question = item.question?.toString().replace(/^\d+\.\s*/, '').normalize('NFC').replace(/\s+/g, ' ').trim();
      const userAnswer = item.answer?.toString().normalize('NFC').replace(/\s+/g, ' ').trim();

      if (!userAnswer) {
        unansweredQuestions.push(index + 1);
        responseRow.push(question, "NOT ANSWERED", "❌ (Empty)");
        return;
      }

      const comparisonResult = compareAnswers(question, userAnswer, answerMap, datasetSheet);
      responseRow.push(comparisonResult.question, comparisonResult.userAnswer, comparisonResult.result);
      
      if (comparisonResult.isCorrect) {
        score += 2;
      }
    });

    // Validate all questions were answered
    if (unansweredQuestions.length > 0) {
      return { 
        status: "error", 
        message: `Please answer all questions. Missing answers for questions: ${unansweredQuestions.join(', ')}` 
      };
    }

    // Append results
    responseRow.push(score, score >= 10 ? "Pass" : "Fail");
    responseSheet.appendRow(responseRow);
    
    // Send email with error handling
    try {
      const emailResult = sendResultEmail(email, score, score >= 10 ? "Pass" : "Fail");
      if (emailResult !== true) {
        console.error("Email sending failed:", emailResult);
        // Continue processing even if email fails
      }
    } catch (e) {
      console.error("Email error:", e.message);
    }

    return { 
      status: "success", 
      message: "Your answers have been submitted successfully.", 
      score: score,
      result: score >= 10 ? "Pass" : "Fail",
      timestamp: new Date().toISOString()
    };

  } catch (e) {
    console.error("Error in submitAnswers:", e.message, e.stack);
    return { 
      status: "error", 
      message: "An error occurred while processing your submission. Please try again.",
      error: e.message 
    };
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {
      console.error("Error releasing lock:", e.message);
    }
  }
}
function checkEmailDuplicate(email) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Result");
  if (!sheet || sheet.getLastRow() <= 1) return false;
  
  const emailCol = 2; // Column B
  const emails = sheet.getRange(2, emailCol, sheet.getLastRow()-1, 1)
    .getValues()
    .flat()
    .map(e => e.toString().trim().toLowerCase());
    
  return emails.includes(email.toLowerCase().trim());
}

// Function to compare the answer and return the result
function compareAnswers(question, userAnswer, answerMap, datasetSheet) {
  const correctAnswer = answerMap[question];
  
  // Find the row of the question in the dataset
  const dataset = datasetSheet.getDataRange().getValues();
  let correctOption = '';
  
  for (let i = 1; i < dataset.length; i++) {
    if (dataset[i][1]?.toString().normalize('NFC').replace(/\s+/g, ' ').trim() === question) {
      correctOption = dataset[i][7]?.toString().trim();  // Column 8 has the correct answer (e.g., A, B, C, D, E)
      break;
    }
  }

  // Compare the user's answer with the correct answer
  const normalizedUser = userAnswer.toLowerCase().trim();
  const normalizedCorrect = correctOption.toLowerCase().trim();

  const isCorrect = normalizedUser === normalizedCorrect;
  
  return {
    question: question,
    userAnswer: userAnswer,
    result: isCorrect ? "✅ Correct" : "❌ Incorrect",
    isCorrect: isCorrect
  };
}

function sendResultEmail(email, score, result) {
  const subject = result === "Pass" ? "🎉 Congratulations! You Passed" : "😢 Sorry, You Didn't Pass";
  const body = `Hi ${email},\n\n` +
    (result === "Pass" 
      ? "🎉 Congratulations! You passed the quiz! Great job on your effort and knowledge. Keep up the excellent work!\n\n"
      : "😢 Sorry, you didn't pass the quiz this time. Don't worry, you gave it your best shot! Review the material and try again when you're ready. We're here to help you succeed!\n\n") +
    `Your score: ${score}\n\n` +
    "Thank you for participating! If you have any questions or need further assistance, feel free to reach out. We're always here to support you.\n\n" +
    "See you next time!";

  try {
    MailApp.sendEmail({
      to: email,
      subject: subject,
      body: body,
      name: "FDB Quick System", // Custom sender name
      replyTo: "thantzino1541999@gmail.com" // Custom reply-to address
    });
  } catch (e) {
    Logger.log("Error sending email: " + e.message);
  }
}

function setupHeaders() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Result");
    var headers = ["Timestamp", "Email"];
    for (var i = 1; i <= 10; i++) {
      headers.push(`Q${i}`, `A${i}`, `Status`);
    }
    headers.push("Score", "Result");
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } catch (e) {
    Logger.log("Error setting up headers: " + e.message);
  }
}
