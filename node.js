function input_data(){
    const fs = require('fs');

const fifoPath = 'qzss_pipe';

const stream = fs.createReadStream(fifoPath, { encoding: 'utf8' });

stream.on('data', (chunk) => {
  console.log('受信データ:', chunk);
});

stream.on('error', (err) => {
  console.error('エラー:', err);
});

}
input_data()